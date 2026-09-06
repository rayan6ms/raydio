// Linux-only diagnostic interposer; never linked into the release bot.
// Records RTP header counters, send completion time and syscall duration only.
// No payloads, addresses, audio, credentials, or TLS traffic are recorded.
// Scope LD_PRELOAD and RAYDIO_UDP_TRACE to the owned testbot process.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static ssize_t (*native_send)(int, const void *, size_t, int);
static ssize_t (*native_sendto)(int, const void *, size_t, int, const struct sockaddr *, socklen_t);
static ssize_t (*native_sendmsg)(int, const struct msghdr *, int);
static int trace_fd = -1;
static atomic_uint count;

__attribute__((constructor)) static void initialize(void) {
    native_send = dlsym(RTLD_NEXT, "send");
    native_sendto = dlsym(RTLD_NEXT, "sendto");
    native_sendmsg = dlsym(RTLD_NEXT, "sendmsg");
    const char *path = getenv("RAYDIO_UDP_TRACE");
    if (path) trace_fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
}

static uint64_t now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000 + ts.tv_nsec;
}

static void record(int fd, const void *data, size_t len, ssize_t sent, uint64_t start) {
    const unsigned char *p = data;
    if (trace_fd < 0 || len < 12 || p[0] != 0x80 || p[1] != 0x78) return;
    int type = 0;
    socklen_t size = sizeof(type);
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &size) || type != SOCK_DGRAM) return;
    // Hard limit: at most twenty minutes at one 20 ms packet per opportunity.
    if (atomic_fetch_add_explicit(&count, 1, memory_order_relaxed) >= 60000) return;
    uint64_t end = now_ns();
    unsigned sequence = ((unsigned)p[2] << 8) | p[3];
    uint32_t timestamp = ((uint32_t)p[4] << 24) | ((uint32_t)p[5] << 16) | ((uint32_t)p[6] << 8) | p[7];
    char line[192];
    int n = snprintf(line, sizeof(line), "%llu,%llu,%d,%u,%u,%zu,%zd\n",
                     (unsigned long long)end, (unsigned long long)(end-start),
                     fd, sequence, timestamp, len, sent);
    if (n > 0 && (size_t)n < sizeof(line)) { ssize_t ignored = write(trace_fd, line, n); (void)ignored; }
}

ssize_t send(int fd, const void *buf, size_t len, int flags) {
    uint64_t start = now_ns();
    ssize_t sent = native_send(fd, buf, len, flags);
    int saved_errno = errno;
    record(fd, buf, len, sent, start);
    errno = saved_errno;
    return sent;
}

ssize_t sendto(int fd, const void *buf, size_t len, int flags, const struct sockaddr *addr, socklen_t addrlen) {
    uint64_t start = now_ns();
    ssize_t sent = native_sendto(fd, buf, len, flags, addr, addrlen);
    int saved_errno = errno;
    record(fd, buf, len, sent, start);
    errno = saved_errno;
    return sent;
}

ssize_t sendmsg(int fd, const struct msghdr *msg, int flags) {
    uint64_t start = now_ns();
    ssize_t sent = native_sendmsg(fd, msg, flags);
    int saved_errno = errno;
    if (msg->msg_iovlen == 1) record(fd, msg->msg_iov[0].iov_base, msg->msg_iov[0].iov_len, sent, start);
    errno = saved_errno;
    return sent;
}
