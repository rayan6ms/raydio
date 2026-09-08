/* Diagnostic-only supervisor for the unchanged native bot. No audio hooks.
 * One sample/second; bounded threads and reads; PSS only every 30 seconds.
 * stdout is one bounded JSON line/sample. Never reads argv or environment.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

typedef unsigned long long U;
static volatile sig_atomic_t child;
static void forward(int sig) { if (child > 0) kill(child, sig); }
static U ns(clockid_t clock) {
    struct timespec ts;
    if (clock_gettime(clock, &ts)) return 0;
    return (U)ts.tv_sec * 1000000000 + (U)ts.tv_nsec;
}
static int read_file(const char *path, char *buffer, size_t capacity) {
    FILE *f = fopen(path, "re");
    if (!f) { buffer[0] = 0; return 0; }
    size_t n = fread(buffer, 1, capacity - 1, f);
    int ok = !ferror(f) && feof(f);
    buffer[n] = 0;
    fclose(f);
    return ok;
}
static long long field(const char *buffer, const char *key) {
    size_t len = strlen(key);
    for (const char *p = buffer; p && *p; p = strchr(p, '\n'), p = p ? p + 1 : NULL) {
        if (!strncmp(p, key, len) && (p[len] == ' ' || p[len] == '\t')) {
            char *end;
            long long result = strtoll(p + len, &end, 10);
            if (end != p + len) return result;
        }
    }
    return -1;
}
struct thread { int tid; U run, wait; };
static struct thread previous[128];
static size_t previous_count;

static void sample(unsigned index, U started) {
    U before = ns(CLOCK_MONOTONIC), cpu_before = ns(CLOCK_PROCESS_CPUTIME_ID);
    char path[128], buffer[16384], cpu[4096], memory[64], maximum[128];
    snprintf(path, sizeof(path), "/proc/%d/status", child);
    int status_ok = read_file(path, buffer, sizeof(buffer));
    long long rss = field(buffer, "VmRSS:"), thread_count = field(buffer, "Threads:");
    long long pss = -1;
    if (index % 30 == 0) {
        snprintf(path, sizeof(path), "/proc/%d/smaps_rollup", child);
        read_file(path, buffer, sizeof(buffer));
        pss = field(buffer, "Pss:");
    }
    int cpu_ok = read_file("/sys/fs/cgroup/cpu.stat", cpu, sizeof(cpu));
    read_file("/sys/fs/cgroup/cpu.max", maximum, sizeof(maximum));
    long long quota = -1, period = -1;
    if (sscanf(maximum, "%lld %lld", &quota, &period) != 2) {
        quota = -1; sscanf(maximum, "max %lld", &period);
    }
    int mem_ok = read_file("/sys/fs/cgroup/memory.current", memory, sizeof(memory));
    U run_delta = 0, wait_delta = 0, max_wait = 0;
    int max_tid = 0, truncated = 0;
    struct thread current[128]; size_t count = 0;
    snprintf(path, sizeof(path), "/proc/%d/task", child);
    DIR *dir = opendir(path);
    int tasks_ok = dir != NULL;
    if (dir) {
        struct dirent *entry;
        while ((entry = readdir(dir))) {
            char *end; long tid = strtol(entry->d_name, &end, 10);
            if (*end || tid <= 0) continue;
            if (count == 128) { truncated = 1; break; }
            snprintf(path, sizeof(path), "/proc/%d/task/%ld/schedstat", child, tid);
            U run, wait;
            if (!read_file(path, buffer, sizeof(buffer)) || sscanf(buffer, "%llu %llu", &run, &wait) != 2) {
                tasks_ok = 0; continue;
            }
            current[count++] = (struct thread){(int)tid, run, wait};
            for (size_t j = 0; j < previous_count; ++j) {
                if (previous[j].tid != tid) continue;
                if (run >= previous[j].run && wait >= previous[j].wait) {
                    U delta = wait - previous[j].wait;
                    run_delta += run - previous[j].run;
                    wait_delta += delta;
                    if (delta > max_wait) { max_wait = delta; max_tid = (int)tid; }
                }
                break;
            }
        }
        closedir(dir);
    }
    memcpy(previous, current, count * sizeof(current[0])); previous_count = count;
    printf("{\"kind\":\"host-sample\",\"utcNs\":%llu,\"elapsedNs\":%llu,\"pid\":%d,"
           "\"statusOk\":%d,\"rssKiB\":%lld,\"pssKiB\":%lld,\"threads\":%lld,"
           "\"cgroupCpuOk\":%d,\"cpuQuotaUs\":%lld,\"cpuPeriodUs\":%lld,"
           "\"cpuUsageUs\":%lld,\"periods\":%lld,\"throttledPeriods\":%lld,\"throttledUs\":%lld,"
           "\"cgroupMemoryBytes\":%lld,\"tasksOk\":%d,\"tasksTruncated\":%d,"
           "\"threadRunDeltaNs\":%llu,\"threadWaitDeltaNs\":%llu,\"maxThreadWaitDeltaNs\":%llu,\"maxWaitTid\":%d,"
           "\"sampleWallNs\":%llu,\"sampleCpuNs\":%llu,\"samplerCpuNs\":%llu}\n",
           ns(CLOCK_REALTIME), before-started, child, status_ok, rss, pss, thread_count,
           cpu_ok, quota, period, field(cpu,"usage_usec"), field(cpu,"nr_periods"),
           field(cpu,"nr_throttled"), field(cpu,"throttled_usec"), mem_ok ? strtoll(memory,NULL,10) : -1,
           tasks_ok, truncated, run_delta, wait_delta, max_wait, max_tid,
           ns(CLOCK_MONOTONIC)-before, ns(CLOCK_PROCESS_CPUTIME_ID)-cpu_before, ns(CLOCK_PROCESS_CPUTIME_ID));
    fflush(stdout);
}

int main(int argc, char **argv) {
    if (argc < 4 || strcmp(argv[2], "--")) {
        fputs("Usage: container-sampler SECONDS -- PROGRAM [ARG...]\n", stderr); return 2;
    }
    char *end; long seconds = strtol(argv[1], &end, 10);
    if (*end || seconds < 1 || seconds > 25200) return 2;
    struct sigaction action = {.sa_handler=forward};
    sigemptyset(&action.sa_mask);
    sigaction(SIGTERM,&action,NULL); sigaction(SIGINT,&action,NULL);
    sigset_t mask, old; sigemptyset(&mask); sigaddset(&mask,SIGTERM); sigaddset(&mask,SIGINT);
    sigprocmask(SIG_BLOCK,&mask,&old);
    pid_t parent = getpid(), pid = fork();
    if (pid < 0) { perror("fork"); return 1; }
    if (pid == 0) {
        prctl(PR_SET_PDEATHSIG, SIGTERM);
        if (getppid() != parent) _exit(1);
        signal(SIGTERM,SIG_DFL); signal(SIGINT,SIG_DFL);
        sigprocmask(SIG_SETMASK,&old,NULL);
        execv(argv[3], &argv[3]); perror("execv"); _exit(127);
    }
    child = pid; sigprocmask(SIG_SETMASK,&old,NULL);
    U started=ns(CLOCK_MONOTONIC); unsigned index=0;
    for (;;) {
        int status; pid_t result=waitpid(pid,&status,WNOHANG);
        if (result==pid) return WIFEXITED(status) ? WEXITSTATUS(status) : 128+WTERMSIG(status);
        if (result<0 && errno!=EINTR) return 1;
        if (index <= (unsigned)seconds) sample(index,started);
        ++index;
        struct timespec next = {.tv_sec=(time_t)(started/1000000000)+index,.tv_nsec=(long)(started%1000000000)};
        /* Skip old sampling deadlines after a stall; never burst to catch up. */
        U now=ns(CLOCK_MONOTONIC);
        if (now > started+(U)index*1000000000) {
            index=(unsigned)((now-started)/1000000000)+1;
            next.tv_sec=(time_t)(started/1000000000)+index;
        }
        clock_nanosleep(CLOCK_MONOTONIC,TIMER_ABSTIME,&next,NULL);
    }
}
