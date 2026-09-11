// Offline only. Uses the deployment's pinned libopus; never intercepts live audio.
// Input: little-endian u16 length followed by one 20 ms stereo Opus packet.
// cc -O2 -I <opus-out>/include/opus opus_loss_probe.c <opus-out>/lib64/libopus.a -lm -o opus-loss-probe
// Run: opus-loss-probe source.bin fec_setting loss_hint burst_length
// Drops the same frames (every 100 frames, after warm-up) for every configuration.
#include <opus.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

enum { FRAME = 960, SAMPLES = 1920, MAX_FRAMES = 15000, MAX_PACKET = 1275 };
typedef struct { unsigned char data[MAX_PACKET]; int len; } Packet;

static int loss_offset;
static int missing(int i, int burst) { return i >= 100 && (i + loss_offset) % 100 < burst; }
static void check(int code) { if (code < 0) { fprintf(stderr, "%s\n", opus_strerror(code)); exit(1); } }
static double cpu(void) { return (double)clock() / CLOCKS_PER_SEC; }

int main(int argc, char **argv) {
    if (argc != 5 && argc != 6) return 2;
    loss_offset = argc == 6 ? atoi(argv[5]) : 0;
    if (loss_offset < 0 || loss_offset >= 100) return 2;
    int fec = atoi(argv[2]), hint = atoi(argv[3]), burst = atoi(argv[4]);
    if (fec < 0 || fec > 2 || hint < 0 || hint > 100 || burst < 1 || burst > 10) return 2;
    FILE *f = fopen(argv[1], "rb");
    if (!f) return 2;
    Packet *packets = calloc(MAX_FRAMES, sizeof(*packets));
    float *source = calloc((size_t)MAX_FRAMES * SAMPLES, sizeof(float));
    if (!packets || !source) return 2;
    int error, count = 0, lbrr = 0, celt = 0, hybrid = 0, silk = 0;
    OpusDecoder *input = opus_decoder_create(48000, 2, &error); check(error);
    OpusEncoder *enc = opus_encoder_create(48000, 2, OPUS_APPLICATION_AUDIO, &error); check(error);
    check(opus_encoder_ctl(enc, OPUS_SET_COMPLEXITY(10)));
    check(opus_encoder_ctl(enc, OPUS_SET_INBAND_FEC(fec)));
    check(opus_encoder_ctl(enc, OPUS_SET_PACKET_LOSS_PERC(hint)));
    int lookahead; check(opus_encoder_ctl(enc, OPUS_GET_LOOKAHEAD(&lookahead)));
    unsigned char header[2], raw[MAX_PACKET];
    int16_t scaled[SAMPLES];
    int multiplier = (int)(tanf(70.0f * 0.0079f) * 10000.0f);
    uint64_t bytes = 0;
    double encoding_cpu = 0;
    for (;;) {
        size_t header_bytes = fread(header, 1, 2, f);
        if (header_bytes == 0 && !ferror(f)) break;
        if (header_bytes != 2) return 1;
        unsigned n = header[0] | ((unsigned)header[1] << 8);
        if (!n || n > MAX_PACKET || count == MAX_FRAMES || fread(raw, 1, n, f) != n) return 1;
        float *pcm = source + (size_t)count * SAMPLES;
        int decoded = opus_decode_float(input, raw, n, pcm, FRAME, 0); check(decoded);
        if (decoded != FRAME) return 1;
        // Mantle quantizes to i16 before applying integer volume scaling.
        for (int j = 0; j < SAMPLES; j++) {
            int v = (int)(pcm[j] * 32768.0f);
            v = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
            scaled[j] = v * multiplier / 10000;
            pcm[j] = scaled[j] / 32768.0f;
        }
        double start = cpu();
        int len = opus_encode(enc, scaled, FRAME, packets[count].data, MAX_PACKET); check(len);
        encoding_cpu += cpu() - start;
        packets[count].len = len; bytes += len;
        int mode = packets[count].data[0] >> 3;
        celt += mode >= 16; hybrid += mode >= 12 && mode < 16; silk += mode < 12;
        int has_lbrr = opus_packet_has_lbrr(packets[count].data, len); check(has_lbrr); lbrr += has_lbrr;
        count++;
    }
    if (ferror(f) || !count) return 1;
    fclose(f); opus_decoder_destroy(input); opus_encoder_destroy(enc);
    OpusDecoder *perfect = opus_decoder_create(48000, 2, &error); check(error);
    OpusDecoder *plc = opus_decoder_create(48000, 2, &error); check(error);
    OpusDecoder *recovery = opus_decoder_create(48000, 2, &error); check(error);
    float clean[SAMPLES], concealed[SAMPLES], recovered[SAMPLES];
    double signal = 0, clean_error = 0, plc_error = 0, fec_error = 0, peak = 0;
    double lost_signal = 0, lost_plc_error = 0, lost_fec_error = 0;
    uint64_t clipped = 0, nonfinite = 0; int dropped = 0, recoverable = 0;
    for (int i = 0; i < count; i++) {
        Packet *p = &packets[i]; int lost = missing(i, burst); dropped += lost;
        int decoded = opus_decode_float(perfect, p->data, p->len, clean, FRAME, 0); check(decoded);
        if (decoded != FRAME) return 1;
        decoded = opus_decode_float(plc, lost ? NULL : p->data, lost ? 0 : p->len, concealed, FRAME, 0); check(decoded);
        if (decoded != FRAME) return 1;
        if (lost && i + 1 < count && !missing(i + 1, burst)) {
            Packet *next = &packets[i + 1];
            recoverable += opus_packet_has_lbrr(next->data, next->len) > 0;
            decoded = opus_decode_float(recovery, next->data, next->len, recovered, FRAME, 1);
        } else {
            decoded = opus_decode_float(recovery, lost ? NULL : p->data, lost ? 0 : p->len, recovered, FRAME, 0);
        }
        check(decoded);
        if (decoded != FRAME) return 1;
        for (int j = 0; j < SAMPLES; j++) {
            int64_t k = (int64_t)i * SAMPLES + j - lookahead * 2;
            if (k >= 0) {
                double src = source[k]; signal += src * src;
                double d = clean[j] - src; clean_error += d * d;
            }
            double a = concealed[j] - clean[j], b = recovered[j] - clean[j];
            plc_error += a*a; fec_error += b*b;
            if (lost) { lost_signal += clean[j]*clean[j]; lost_plc_error += a*a; lost_fec_error += b*b; }
            for (int c = 0; c < 3; c++) {
                double v = c == 0 ? clean[j] : c == 1 ? concealed[j] : recovered[j];
                nonfinite += !isfinite(v); clipped += fabs(v) >= 0.99997;
                if (fabs(v) > peak) peak = fabs(v);
            }
        }
    }
    printf("{\"opus\":\"%s\",\"fec\":%d,\"lossHint\":%d,\"burst\":%d,\"offset\":%d,\"frames\":%d,"
           "\"lbrrPackets\":%d,\"celtPackets\":%d,\"hybridPackets\":%d,\"silkPackets\":%d,"
           "\"kbps\":%.3f,\"encodingCpuSeconds\":%.6f,\"cleanSnrDb\":%.4f,"
           "\"dropped\":%d,\"recoverableLbrr\":%d,\"plcError\":%.9g,\"fecError\":%.9g,"
           "\"lostFramePlcSnrDb\":%.4f,\"lostFrameFecSnrDb\":%.4f,"
           "\"clippedSamples\":%llu,\"nonfiniteSamples\":%llu,\"peak\":%.6f}\n",
           opus_get_version_string(), fec, hint, burst, loss_offset, count, lbrr, celt, hybrid, silk,
           bytes * 8.0 / (count * .02) / 1000, encoding_cpu, 10*log10(signal/clean_error),
           dropped, recoverable, plc_error, fec_error, 10*log10(lost_signal/lost_plc_error),
           10*log10(lost_signal/lost_fec_error), (unsigned long long)clipped,
           (unsigned long long)nonfinite, peak);
    opus_decoder_destroy(perfect); opus_decoder_destroy(plc); opus_decoder_destroy(recovery);
    free(packets); free(source); return 0;
}
