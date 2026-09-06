// Independent system-libopus audit of source_packets' length-prefixed output.
// Retains aggregate measurements only. Never load this into a running bot.
// cc -O2 decode_source_packets.c -Wl,-l:libopus.so.0 -lm -o decode-source
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct OpusDecoder OpusDecoder;
extern OpusDecoder *opus_decoder_create(int, int, int *);
extern int opus_decode_float(OpusDecoder *, const unsigned char *, int, float *, int, int);
extern void opus_decoder_destroy(OpusDecoder *);
extern const char *opus_get_version_string(void);

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    FILE *input = fopen(argv[1], "rb");
    if (!input) return 2;
    int error = 0;
    OpusDecoder *decoder = opus_decoder_create(48000, 2, &error);
    if (!decoder || error) return 2;
    unsigned char header[2], packet[1275];
    float pcm[5760 * 2];
    uint64_t samples = 0, quiet = 0, longest = 0, clipped = 0, nonfinite = 0;
    unsigned frames = 0, wrong_duration = 0, tiny = 0;
    double peak = 0, squared = 0;
    printf("{\"decoder\":\"%s\",\"quietIntervals\":[", opus_get_version_string());
    int first = 1, failed = 0;
    for (;;) {
        size_t n = fread(header, 1, 2, input);
        if (!n && !ferror(input)) break;
        if (n != 2) { failed = 1; break; }
        unsigned len = header[0] | ((unsigned)header[1] << 8);
        if (!len || len > sizeof(packet) || frames == 15000 ||
            fread(packet, 1, len, input) != len) { failed = 1; break; }
        int decoded = opus_decode_float(decoder, packet, (int)len, pcm, 5760, 0);
        if (decoded <= 0) { failed = 1; break; }
        frames++;
        wrong_duration += decoded != 960;
        tiny += len <= 3;
        for (int i = 0; i < decoded; i++) {
            int is_quiet = 1;
            for (int c = 0; c < 2; c++) {
                double v = pcm[2*i+c];
                if (!isfinite(v)) { nonfinite++; continue; }
                squared += v*v;
                double a = fabs(v);
                if (a > peak) peak = a;
                clipped += a >= 0.99997;
                if (a > 0.00001) is_quiet = 0;
            }
            if (is_quiet) {
                quiet++;
                if (quiet > longest) longest = quiet;
            } else if (quiet) {
                if (quiet >= 960) {
                    printf("%s{\"startSeconds\":%.6f,\"durationMs\":%.6f}",
                           first ? "" : ",", (samples-quiet)/48000.0, quiet/48.0);
                    first = 0;
                }
                quiet = 0;
            }
            samples++;
        }
    }
    if (quiet >= 960) {
        printf("%s{\"startSeconds\":%.6f,\"durationMs\":%.6f,\"atEnd\":true}",
               first ? "" : ",", (samples-quiet)/48000.0, quiet/48.0);
    }
    printf("],\"frames\":%u,\"seconds\":%.6f,\"wrongFrameDuration\":%u,"
           "\"tinyPackets\":%u,\"longestQuietMs\":%.6f,\"nearFullScale\":%llu,"
           "\"nonFinite\":%llu,\"peak\":%.9f,\"rms\":%.9f,\"failed\":%s}\n",
           frames, samples/48000.0, wrong_duration, tiny, longest/48.0,
           (unsigned long long)clipped, (unsigned long long)nonfinite,
           peak, sqrt(squared/(samples ? 2.0*samples : 1)), failed ? "true" : "false");
    opus_decoder_destroy(decoder);
    fclose(input);
    return failed ? 1 : 0;
}
