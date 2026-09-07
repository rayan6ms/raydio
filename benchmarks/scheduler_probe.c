// Linux diagnostic only. Two pinned, sleeping timers and one-second CPU-steal
// samples distinguish host scheduling delays from application-only delays.
// No busy waiting, packet capture, real-time priority, or production linkage.
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <time.h>

#define LIMIT 1200
#define EVENTS 2048
#define PERIOD 20000000ULL
struct event { uint64_t at, late; };
struct timer {
    int cpu, error;
    unsigned count, truncated, wakes;
    uint64_t max_late;
    struct event events[EVENTS];
};
struct sample { uint64_t at, steal[2]; };
static struct timer timers[2];
static struct sample samples[LIMIT + 1];
static uint64_t begin, finish;

static uint64_t now(clockid_t clock) {
    struct timespec ts;
    if (clock_gettime(clock, &ts)) abort();
    return (uint64_t)ts.tv_sec * 1000000000ULL + ts.tv_nsec;
}
static int until(uint64_t deadline) {
    struct timespec ts = {deadline / 1000000000ULL, deadline % 1000000000ULL};
    int result;
    do { result = clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &ts, NULL); }
    while (result == EINTR);
    return result;
}
static void *observe(void *arg) {
    struct timer *t = arg;
    cpu_set_t mask; CPU_ZERO(&mask); CPU_SET(t->cpu, &mask);
    t->error = pthread_setaffinity_np(pthread_self(), sizeof(mask), &mask);
    if (t->error) return NULL;
    for (uint64_t deadline = begin + PERIOD; deadline <= finish;) {
        if ((t->error = until(deadline))) return NULL;
        uint64_t at = now(CLOCK_MONOTONIC);
        uint64_t late = at > deadline ? at - deadline : 0;
        t->wakes++;
        if (late > t->max_late) t->max_late = late;
        if (late >= 10000000ULL) {
            if (t->count < EVENTS) t->events[t->count++] = (struct event){at, late};
            else t->truncated++;
        }
        deadline += PERIOD;
        if (deadline <= at) deadline += ((at - deadline) / PERIOD + 1) * PERIOD;
    }
    return NULL;
}
int main(int argc, char **argv) {
    char *end = NULL;
    long seconds = argc == 2 ? strtol(argv[1], &end, 10) : 0;
    if (!end || *end || seconds < 2 || seconds > LIMIT) return 2;
    if (setpriority(PRIO_PROCESS, 0, 10)) return 3;
    cpu_set_t available;
    if (sched_getaffinity(0, sizeof(available), &available)) return 4;
    int selected = 0;
    for (int cpu = 0; cpu < CPU_SETSIZE && selected < 2; cpu++)
        if (CPU_ISSET(cpu, &available)) timers[selected++].cpu = cpu;
    if (selected != 2) return 5;
    begin = now(CLOCK_MONOTONIC); finish = begin + (uint64_t)seconds * 1000000000ULL;
    uint64_t cpu_start = now(CLOCK_PROCESS_CPUTIME_ID);
    pthread_t threads[2];
    for (int i = 0; i < 2; i++) if (pthread_create(&threads[i], NULL, observe, &timers[i])) return 6;
    unsigned count = 0;
    for (long second = 0; second <= seconds; second++) {
        if (until(begin + (uint64_t)second * 1000000000ULL)) return 7;
        FILE *f = fopen("/proc/stat", "r");
        if (!f) return 8;
        struct sample *s = &samples[count++]; s->at = now(CLOCK_MONOTONIC);
        char line[1024]; unsigned found = 0;
        while (fgets(line, sizeof(line), f)) {
            unsigned cpu; unsigned long long user, nice, system, idle, io, irq, softirq, steal;
            if (sscanf(line, "cpu%u %llu %llu %llu %llu %llu %llu %llu %llu",
                &cpu, &user, &nice, &system, &idle, &io, &irq, &softirq, &steal) != 9) continue;
            for (int i = 0; i < 2; i++) if ((unsigned)timers[i].cpu == cpu) {
                s->steal[i] = steal; found++;
            }
        }
        fclose(f);
        if (found != 2) return 9;
    }
    for (int i = 0; i < 2; i++) pthread_join(threads[i], NULL);
    printf("summary,%llu,%llu,%llu\n", (unsigned long long)begin,
        (unsigned long long)now(CLOCK_MONOTONIC),
        (unsigned long long)(now(CLOCK_PROCESS_CPUTIME_ID) - cpu_start));
    for (int i = 0; i < 2; i++) {
        struct timer *t = &timers[i];
        printf("timer,%d,%u,%llu,%u,%d\n", t->cpu, t->wakes,
            (unsigned long long)t->max_late, t->truncated, t->error);
        for (unsigned j = 0; j < t->count; j++) printf("late,%d,%llu,%llu\n", t->cpu,
            (unsigned long long)t->events[j].at, (unsigned long long)t->events[j].late);
    }
    for (unsigned j = 0; j < count; j++) for (int i = 0; i < 2; i++)
        printf("steal,%d,%llu,%llu\n", timers[i].cpu,
            (unsigned long long)samples[j].at, (unsigned long long)samples[j].steal[i]);
    return timers[0].error || timers[1].error ? 10 : 0;
}
