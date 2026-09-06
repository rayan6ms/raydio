// Linux source-read diagnostic only; never linked into the bot.
// Logs slow socket reads without payload, URL, address, or credentials.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdint.h>
#include <stdatomic.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static ssize_t (*real_read)(int, void *, size_t);
static ssize_t (*real_recv)(int, void *, size_t, int);
static ssize_t (*real_recvfrom)(int, void *, size_t, int, struct sockaddr *, socklen_t *);
static atomic_uint slow_count;
__attribute__((constructor)) static void init(void) {
    real_read=dlsym(RTLD_NEXT,"read");
    real_recv=dlsym(RTLD_NEXT,"recv");
    real_recvfrom=dlsym(RTLD_NEXT,"recvfrom");
}
static uint64_t ns(clockid_t clock) {
    struct timespec t; clock_gettime(clock,&t);
    return (uint64_t)t.tv_sec*1000000000+t.tv_nsec;
}
static void slow(int fd, ssize_t result, uint64_t start, uint64_t cpu, int err) {
    uint64_t end=ns(CLOCK_MONOTONIC);
    if(end-start<20000000) return;
    uint64_t used=ns(CLOCK_THREAD_CPUTIME_ID)-cpu;
    int type=0; socklen_t len=sizeof(type);
    if(getsockopt(fd,SOL_SOCKET,SO_TYPE,&type,&len)) return;
    if(atomic_fetch_add_explicit(&slow_count,1,memory_order_relaxed)>=500) return;
    char line[240];
    int n=snprintf(line,sizeof(line),"{\"kind\":\"slow-socket-read\",\"endMonotonicNs\":%llu,\"wallMs\":%.6f,\"cpuMs\":%.6f,\"bytes\":%zd,\"errno\":%d}\n",(unsigned long long)end,(end-start)/1e6,used/1e6,result,result<0?err:0);
    if(n>0&&(size_t)n<sizeof(line)){ssize_t ignored=write(2,line,n);(void)ignored;}
}
ssize_t read(int fd,void *data,size_t len) {
    uint64_t cpu=ns(CLOCK_THREAD_CPUTIME_ID),start=ns(CLOCK_MONOTONIC);
    ssize_t result=real_read(fd,data,len);int err=errno;
    slow(fd,result,start,cpu,err);errno=err;return result;
}
ssize_t recv(int fd,void *data,size_t len,int flags) {
    uint64_t cpu=ns(CLOCK_THREAD_CPUTIME_ID),start=ns(CLOCK_MONOTONIC);
    ssize_t result=real_recv(fd,data,len,flags);int err=errno;
    slow(fd,result,start,cpu,err);errno=err;return result;
}
ssize_t recvfrom(int fd,void *data,size_t len,int flags,struct sockaddr *addr,socklen_t *addrlen) {
    uint64_t cpu=ns(CLOCK_THREAD_CPUTIME_ID),start=ns(CLOCK_MONOTONIC);
    ssize_t result=real_recvfrom(fd,data,len,flags,addr,addrlen);int err=errno;
    slow(fd,result,start,cpu,err);errno=err;return result;
}
