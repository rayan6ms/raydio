#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <time.h>
#include <string.h>
#include <sys/resource.h>

static uint64_t now(clockid_t clock) {
    struct timespec t;
    if (clock_gettime(clock, &t)) return 0;
    return (uint64_t)t.tv_sec * 1000000000ULL + t.tv_nsec;
}

int main(void) {
    unsigned char input[1275], output[1275];
    memset(input, 0x73, sizeof input);
    uint64_t begin=now(CLOCK_MONOTONIC), total=0, wall_overruns=0, cpu_overruns=0;
    uint64_t max_wall=0, max_cpu=0;
    struct rusage before, after;
    getrusage(RUSAGE_THREAD, &before);
    // 128 tiny probes per 20 ms, maximum 120 seconds, one thread. No bot/audio
    // runs in this process. This diagnoses clock attribution, not audio quality.
    while (now(CLOCK_MONOTONIC)-begin < 120000000000ULL) {
        uint64_t cycle=now(CLOCK_MONOTONIC);
        for (unsigned i=0; i<128; ++i) {
            uint64_t cpu_start=now(CLOCK_THREAD_CPUTIME_ID);
            uint64_t wall_start=now(CLOCK_MONOTONIC);
            memcpy(output,input,sizeof input);
            __asm__ volatile("" : : "m"(output) : "memory");
            uint64_t wall=now(CLOCK_MONOTONIC)-wall_start;
            ++total;
            if(wall>max_wall)max_wall=wall;
            if(wall>2000000ULL) {
                uint64_t cpu=now(CLOCK_THREAD_CPUTIME_ID)-cpu_start;
                ++wall_overruns;
                if(cpu>max_cpu)max_cpu=cpu;
                if(cpu>2000000ULL)++cpu_overruns;
                printf("{\"elapsedNs\":%llu,\"wallNs\":%llu,\"cpuNs\":%llu}\n",
                    (unsigned long long)(now(CLOCK_MONOTONIC)-begin),
                    (unsigned long long)wall,(unsigned long long)cpu);
                fflush(stdout);
            }
        }
        uint64_t deadline=cycle+20000000ULL;
        struct timespec target={(time_t)(deadline/1000000000ULL),(long)(deadline%1000000000ULL)};
        clock_nanosleep(CLOCK_MONOTONIC,TIMER_ABSTIME,&target,NULL);
    }
    getrusage(RUSAGE_THREAD,&after);
    printf("{\"probes\":%llu,\"wallOverruns\":%llu,\"cpuOverruns\":%llu,\"maxWallNs\":%llu,\"maxCpuOverrunNs\":%llu,\"userUs\":%ld,\"systemUs\":%ld}\n",
        (unsigned long long)total,(unsigned long long)wall_overruns,(unsigned long long)cpu_overruns,
        (unsigned long long)max_wall,(unsigned long long)max_cpu,
        (after.ru_utime.tv_sec-before.ru_utime.tv_sec)*1000000+after.ru_utime.tv_usec-before.ru_utime.tv_usec,
        (after.ru_stime.tv_sec-before.ru_stime.tv_sec)*1000000+after.ru_stime.tv_usec-before.ru_stime.tv_usec);
}
