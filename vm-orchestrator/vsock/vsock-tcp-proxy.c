#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <linux/vm_sockets.h>
#include <sys/wait.h>
#include <signal.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <errno.h>
#include <time.h>

#define VSOCK_PORT 8080
#define TCP_PORT 8080
#define VMADDR_CID_ANY -1U

#define LOG_FILE "/tmp/vsock-tcp-proxy.log"

static void log_both(const char *message) {
    // Get timestamp
    time_t now = time(NULL);
    struct tm *t = gmtime(&now);
    char timestamp[32];
    strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%SZ", t);
    
    char line[512];
    snprintf(line, sizeof(line), "%s %s", timestamp, message);
    
    // Log to stdout FIRST (matches logBoth behavior)
    fprintf(stdout, "%s\n", line);
    fflush(stdout);
    
    return;

    // Then log to file (independent - doesn't block on stdout failure)
    FILE *fp = fopen(LOG_FILE, "a");
    if (fp) {
        fprintf(fp, "%s\n", line);
        fclose(fp);
    }
}

static void log_both_errno(const char *prefix) {
    char buf[256];
    snprintf(buf, sizeof(buf), "%s: %s", prefix, strerror(errno));
    log_both(buf);
}

static int write_all(int fd, const void *buf, size_t len) {
    const char *ptr = (const char *)buf;
    size_t remaining = len;
    while (remaining > 0) {
        ssize_t written = write(fd, ptr, remaining);
        if (written < 0 && errno == EINTR) {
            continue;
        }
        if (written <= 0) {
            return -1;
        }
        ptr += written;
        remaining -= (size_t)written;
    }
    return 0;
}

void handle_client(int vsock_fd) {
    // Read and respond to CONNECT handshake from host
    char buf[256];
    int n = read(vsock_fd, buf, sizeof(buf)-1);
    if (n < 0 && errno == EINTR) {
        n = read(vsock_fd, buf, sizeof(buf)-1);
    }
    if (n > 0) {
        buf[n] = 0;
        if (strncmp(buf, "CONNECT", 7) == 0) {
            log_both("[VsockProxy] Handshake received");
            if (write_all(vsock_fd, "OK\n", 3) != 0) {
                log_both_errno("[VsockProxy] Handshake write failed");
                close(vsock_fd);
                return;
            }
        }
    }
    
    // Connect to TCP file server on localhost:8080
    int tcp_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (tcp_fd < 0) {
        perror("tcp socket");
        log_both_errno("[VsockProxy] tcp socket failed");
        close(vsock_fd);
        return;
    }
    
    // Disable Nagle's algorithm for low latency
    int flag = 1;
    setsockopt(tcp_fd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));
    
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(TCP_PORT);
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    
    if (connect(tcp_fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        perror("tcp connect");
        log_both_errno("[VsockProxy] tcp connect failed (127.0.0.1:8080)");
        close(tcp_fd);
        close(vsock_fd);
        return;
    }

    log_both("[VsockProxy] Connected to 127.0.0.1:8080");
    
    // Proxy data bidirectionally
    fd_set readfds;
    char buffer[4096];
    while (1) {
        FD_ZERO(&readfds);
        FD_SET(vsock_fd, &readfds);
        FD_SET(tcp_fd, &readfds);
        
        int maxfd = (vsock_fd > tcp_fd) ? vsock_fd : tcp_fd;

        if (select(maxfd + 1, &readfds, NULL, NULL, NULL) < 0) {
            if (errno == EINTR) continue;
            break;
        }
        
        if (FD_ISSET(vsock_fd, &readfds)) {
            n = read(vsock_fd, buffer, sizeof(buffer));
            if (n < 0 && errno == EINTR) {
                continue;
            }
            if (n <= 0) break;
            if (write_all(tcp_fd, buffer, (size_t)n) != 0) break;
        }
        
        if (FD_ISSET(tcp_fd, &readfds)) {
            n = read(tcp_fd, buffer, sizeof(buffer));
            if (n < 0 && errno == EINTR) {
                continue;
            }
            if (n <= 0) break;
            if (write_all(vsock_fd, buffer, (size_t)n) != 0) break;
        }
    }

    log_both("[VsockProxy] Connection closed");
    
    close(tcp_fd);
    close(vsock_fd);
}

int main() {
    signal(SIGPIPE, SIG_IGN);
    signal(SIGCHLD, SIG_IGN);
    int listen_fd;
    struct sockaddr_vm addr;
    
    listen_fd = socket(AF_VSOCK, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        perror("socket");
        return 1;
    }
    
    int opt = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    
    memset(&addr, 0, sizeof(addr));
    addr.svm_family = AF_VSOCK;
    addr.svm_cid = VMADDR_CID_ANY;
    addr.svm_port = VSOCK_PORT;
    
    if (bind(listen_fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        perror("bind");
        return 1;
    }
    
    if (listen(listen_fd, 5) < 0) {
        perror("listen");
        return 1;
    }
    
    while (1) {
        int conn_fd = accept(listen_fd, NULL, NULL);
        if (conn_fd < 0) continue;
        
        pid_t pid = fork();
        if (pid == 0) {
            close(listen_fd);
            handle_client(conn_fd);
            exit(0);
        }
        close(conn_fd);
    }
    
    return 0;
}
