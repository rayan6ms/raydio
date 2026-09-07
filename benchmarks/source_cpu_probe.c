// Standalone Linux/PMU diagnostic. No bot, network, audio or stress workload.
// Compare the source guard's clocks with hardware instructions and cycles
// around a fixed 1,304-byte copy. At most 128 copies per 20 ms, 15 minutes;
// stop after three overruns. Run only as an explicit diagnostic.
#define _GNU_SOURCE
#include <errno.h>
#include <linux/perf_event.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

struct counts { uint64_t value, enabled, running; };
struct event { uint64_t at, wall, cpu; struct counts c0,c1,i0,i1; };
static uint64_t now(clockid_t clock) {
    struct timespec t;
    if (clock_gettime(clock, &t)) _exit(2);
    return (uint64_t)t.tv_sec * 1000000000ULL + t.tv_nsec;
}
static int counter(uint64_t config) {
    struct perf_event_attr attr = {0};
    attr.size=sizeof(attr); attr.type=PERF_TYPE_HARDWARE; attr.config=config;
    attr.read_format=PERF_FORMAT_TOTAL_TIME_ENABLED|PERF_FORMAT_TOTAL_TIME_RUNNING;
    // Count only this calling thread; no inherited or system-wide events.
    return syscall(SYS_perf_event_open, &attr, 0, -1, -1, PERF_FLAG_FD_CLOEXEC);
}
static struct counts read_count(int fd) {
    struct counts c;
    if (read(fd,&c,sizeof(c))!=sizeof(c)) _exit(3);
    return c;
}
int main(void) {
    int cycles=counter(PERF_COUNT_HW_CPU_CYCLES), instructions=counter(PERF_COUNT_HW_INSTRUCTIONS);
    if(cycles<0||instructions<0) {perror("perf_event_open");return 1;}
    unsigned char input[1304],output[1304]; memset(input,0x73,sizeof(input));
    uint64_t start=now(CLOCK_MONOTONIC),cpu_start=now(CLOCK_PROCESS_CPUTIME_ID),total=0,max_wall=0;
    unsigned used=0; struct event events[3];
    struct rusage before,after; getrusage(RUSAGE_SELF,&before);
    while(now(CLOCK_MONOTONIC)-start<900000000000ULL&&used<3) {
        uint64_t cycle=now(CLOCK_MONOTONIC);
        for(unsigned j=0;j<128&&used<3;j++) {
            struct counts c0=read_count(cycles),i0=read_count(instructions);
            uint64_t cpu0=now(CLOCK_THREAD_CPUTIME_ID),wall0=now(CLOCK_MONOTONIC);
            memcpy(output,input,sizeof(input));
            __asm__ volatile("" : : "m"(output) : "memory");
            uint64_t wall=now(CLOCK_MONOTONIC)-wall0;
            total++;if(wall>max_wall)max_wall=wall;
            if(wall>2000000ULL) {
                uint64_t cpu=now(CLOCK_THREAD_CPUTIME_ID)-cpu0;
                struct counts i1=read_count(instructions),c1=read_count(cycles);
                events[used++]=(struct event){now(CLOCK_MONOTONIC),wall,cpu,c0,c1,i0,i1};
            }
        }
        uint64_t deadline=cycle+20000000ULL;
        struct timespec ts={deadline/1000000000ULL,deadline%1000000000ULL};
        int error; do {error=clock_nanosleep(CLOCK_MONOTONIC,TIMER_ABSTIME,&ts,NULL);}while(error==EINTR);
        if(error)return 4;
    }
    getrusage(RUSAGE_SELF,&after);
    printf("{\"seconds\":%.6f,\"processCpuSeconds\":%.6f,\"copies\":%llu,\"maxWallNs\":%llu,\"minorFaults\":%ld,\"majorFaults\":%ld,\"events\":[",
        (now(CLOCK_MONOTONIC)-start)/1e9,(now(CLOCK_PROCESS_CPUTIME_ID)-cpu_start)/1e9,
        (unsigned long long)total,(unsigned long long)max_wall,
        after.ru_minflt-before.ru_minflt,after.ru_majflt-before.ru_majflt);
    for(unsigned j=0;j<used;j++) {
        struct event *e=&events[j];
        printf("%s{\"monoNs\":%llu,\"wallNs\":%llu,\"cpuNs\":%llu,\"cycles\":%llu,\"instructions\":%llu,\"cyclesEnabledNs\":%llu,\"cyclesRunningNs\":%llu,\"instructionsEnabledNs\":%llu,\"instructionsRunningNs\":%llu}",
            j?",":"",(unsigned long long)e->at,(unsigned long long)e->wall,(unsigned long long)e->cpu,
            (unsigned long long)(e->c1.value-e->c0.value),(unsigned long long)(e->i1.value-e->i0.value),
            (unsigned long long)(e->c1.enabled-e->c0.enabled),(unsigned long long)(e->c1.running-e->c0.running),
            (unsigned long long)(e->i1.enabled-e->i0.enabled),(unsigned long long)(e->i1.running-e->i0.running));
    }
    puts("]}");close(cycles);close(instructions);return 0;
}
