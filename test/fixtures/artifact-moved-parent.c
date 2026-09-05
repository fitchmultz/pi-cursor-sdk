#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <unistd.h>

static ssize_t move_parent_after_write(int fd, const void *buffer, size_t size);
#define write move_parent_after_write
#define main extractor_main
#include "../../scripts/platform-smoke/artifact-openat-extract.c"
#undef main
#undef write

static const char *parent_path;
static const char *escaped_path;
static int moved;

static ssize_t move_parent_after_write(int fd, const void *buffer, size_t size) {
	const ssize_t written = write(fd, buffer, size);
	if (written > 0 && !moved) {
		if (rename(parent_path, escaped_path) != 0) return -1;
		moved = 1;
	}
	return written;
}

int main(int argc, char **argv) {
	if (argc != 6) return 3;
	parent_path = argv[4];
	escaped_path = argv[5];
	const int result = extractor_main(4, argv);
	if (!moved) return 4;
	puts("moved-after-write");
	return result;
}
