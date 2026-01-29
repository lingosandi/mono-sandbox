#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <linux/vm_sockets.h>
#include <sys/wait.h>
#include <pty.h>
#include <signal.h>
#include <termios.h>
#include <errno.h>

#define VSOCK_PORT 1024
#define VMADDR_CID_ANY -1U

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

void handle_client(int conn_fd) {
    char buf[256];
    int n = read(conn_fd, buf, sizeof(buf)-1);
    if (n < 0 && errno == EINTR) {
        n = read(conn_fd, buf, sizeof(buf)-1);
    }
    if (n > 0) {
        buf[n] = 0;
        if (strncmp(buf, "CONNECT", 7) == 0) {
            if (write_all(conn_fd, "OK\n", 3) != 0) {
                close(conn_fd);
                return;
            }
        }
    }
    
    // Set default terminal size (80x24)
    struct winsize ws;
    memset(&ws, 0, sizeof(ws));
    ws.ws_col = 80;
    ws.ws_row = 24;
    
    int master, slave;
    char name[256];
    if (openpty(&master, &slave, name, NULL, &ws) < 0) {
        close(conn_fd);
        return;
    }
    
    pid_t bash_pid = fork();
    if (bash_pid == 0) {
        close(master);
        close(conn_fd);
        setsid();
        dup2(slave, 0);
        dup2(slave, 1);
        dup2(slave, 2);
        close(slave);
        
        // Set TERM environment variable
        setenv("TERM", "xterm-256color", 1);
        
        // Start bash with command to cd to project directory
        // This ensures we start in /mnt/project if it exists and is mounted
        execl("/bin/bash", "/bin/bash", "-c", "cd /mnt/project 2>/dev/null && exec /bin/bash -i || exec /bin/bash -i", NULL);
        exit(1);
    }
    
    close(slave);
    
    fd_set readfds;
    char buffer[4096];
    while (1) {
        FD_ZERO(&readfds);
        FD_SET(conn_fd, &readfds);
        FD_SET(master, &readfds);
        
        int maxfd = (conn_fd > master) ? conn_fd : master;
        if (select(maxfd + 1, &readfds, NULL, NULL, NULL) < 0) {
            if (errno == EINTR) continue;
            break;
        }
        
        if (FD_ISSET(conn_fd, &readfds)) {
            n = read(conn_fd, buffer, sizeof(buffer));
            if (n < 0 && errno == EINTR) {
                continue;
            }
            if (n <= 0) break;
            
            // Check for RESIZE command
            if (n > 7 && strncmp(buffer, "RESIZE ", 7) == 0) {
                int cols, rows;
                if (sscanf(buffer + 7, "%d %d", &cols, &rows) == 2) {
                    ws.ws_col = cols;
                    ws.ws_row = rows;
                    ioctl(master, TIOCSWINSZ, &ws);
                }
                continue;
            }
            
            if (write_all(master, buffer, (size_t)n) != 0) break;
        }
        
        if (FD_ISSET(master, &readfds)) {
            n = read(master, buffer, sizeof(buffer));
            if (n < 0 && errno == EINTR) {
                continue;
            }
            if (n <= 0) break;
            if (write_all(conn_fd, buffer, (size_t)n) != 0) break;
        }
    }
    
    kill(bash_pid, SIGKILL);
    wait(NULL);
    close(master);
    close(conn_fd);
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
