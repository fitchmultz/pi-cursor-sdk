#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef MAX_INPUT
#define MAX_INPUT (64u * 1024u * 1024u)
#endif
#ifndef MAX_FILES
#define MAX_FILES 512u
#endif
#ifndef MAX_FILE_BYTES
#define MAX_FILE_BYTES (5u * 1024u * 1024u)
#endif
#ifndef MAX_TOTAL_BYTES
#define MAX_TOTAL_BYTES (40u * 1024u * 1024u)
#endif
#ifndef MAX_PATH_BYTES
#define MAX_PATH_BYTES 4096u
#endif
#ifndef MAX_PATH_COMPONENTS
#define MAX_PATH_COMPONENTS 4096u
#endif
#define MAX_CREATED_ENTRIES (MAX_PATH_COMPONENTS + MAX_FILES)

typedef struct {
	char *path;
	const unsigned char *content;
	uint32_t size;
} InputFile;

typedef struct {
	char *path;
	char *name;
	dev_t dev;
	ino_t ino;
	int parent_fd;
	int directory;
} CreatedEntry;

/* Run-level destination facts that select the failure exit status in main. */
static int entries_created;
static int cleanup_incomplete;

static uint32_t read_u32(const unsigned char *bytes) {
	return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) | ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

static int canonical_path(const char *path, size_t length) {
	if (length == 0 || length > MAX_PATH_BYTES || path[0] == '/' ||
		(length >= 3 && ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) &&
			path[1] == ':' && path[2] == '/')) return 0;
	size_t start = 0;
	for (size_t index = 0; index <= length; index++) {
		if (index < length && path[index] != '/') {
			if (path[index] == '\\' || path[index] == '\0') return 0;
			continue;
		}
		const size_t segment = index - start;
		if (segment == 0 || (segment == 1 && path[start] == '.') ||
			(segment == 2 && path[start] == '.' && path[start + 1] == '.')) return 0;
		start = index + 1;
	}
	return 1;
}

static int conflicting_paths(const char *left, const char *right) {
	const size_t left_length = strlen(left);
	const size_t right_length = strlen(right);
	if (strcmp(left, right) == 0) return 1;
	return (left_length < right_length && strncmp(left, right, left_length) == 0 && right[left_length] == '/') ||
		(right_length < left_length && strncmp(right, left, right_length) == 0 && left[right_length] == '/');
}

static int read_input(unsigned char **buffer, size_t *length) {
	size_t capacity = 64u * 1024u;
	unsigned char *bytes = malloc(capacity);
	if (!bytes) return 0;
	*length = 0;
	for (;;) {
		if (*length == capacity) {
			if (capacity >= MAX_INPUT) { free(bytes); return 0; }
			capacity *= 2;
			if (capacity > MAX_INPUT) capacity = MAX_INPUT;
			unsigned char *grown = realloc(bytes, capacity);
			if (!grown) { free(bytes); return 0; }
			bytes = grown;
		}
		const ssize_t count = read(STDIN_FILENO, bytes + *length, capacity - *length);
		if (count < 0) { if (errno == EINTR) continue; free(bytes); return 0; }
		if (count == 0) break;
		*length += (size_t)count;
	}
	*buffer = bytes;
	return 1;
}

static int parse_input(unsigned char *buffer, size_t length, InputFile **files_out, uint32_t *count_out) {
	static const unsigned char magic[8] = { 'P', 'I', 'A', 'R', 'T', '0', '1', 0 };
	if (length < 12 || memcmp(buffer, magic, sizeof(magic)) != 0) return 0;
	const uint32_t count = read_u32(buffer + 8);
	if (count > MAX_FILES) return 0;
	if (count == 0) {
		if (length != 12) return 0;
		*files_out = NULL;
		*count_out = 0;
		return 1;
	}
	InputFile *files = calloc(count, sizeof(*files));
	if (!files) return 0;
	size_t offset = 12;
	uint64_t total = 0;
	uint64_t path_components = 0;
	for (uint32_t index = 0; index < count; index++) {
		if (offset + 8 > length) goto fail;
		const uint32_t path_length = read_u32(buffer + offset);
		const uint32_t content_length = read_u32(buffer + offset + 4);
		offset += 8;
		if (path_length == 0 || path_length > MAX_PATH_BYTES || content_length > MAX_FILE_BYTES ||
			offset + (size_t)path_length + (size_t)content_length > length) goto fail;
		files[index].path = malloc((size_t)path_length + 1);
		if (!files[index].path) goto fail;
		memcpy(files[index].path, buffer + offset, path_length);
		files[index].path[path_length] = 0;
		if (!canonical_path(files[index].path, path_length)) goto fail;
		path_components++;
		for (uint32_t byte = 0; byte < path_length; byte++) if (files[index].path[byte] == '/') path_components++;
		if (path_components > MAX_PATH_COMPONENTS) goto fail;
		offset += path_length;
		files[index].content = buffer + offset;
		files[index].size = content_length;
		offset += content_length;
		total += content_length;
		if (total > MAX_TOTAL_BYTES) goto fail;
		for (uint32_t prior = 0; prior < index; prior++) if (conflicting_paths(files[prior].path, files[index].path)) goto fail;
	}
	if (offset != length) goto fail;
	*files_out = files;
	*count_out = count;
	return 1;
fail:
	for (uint32_t index = 0; index < count; index++) free(files[index].path);
	free(files);
	return 0;
}

static int same_identity(const struct stat *left, const struct stat *right) {
	return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static int open_root(const char *path, struct stat *identity) {
	struct stat before, after, opened;
	if (lstat(path, &before) != 0 || !S_ISDIR(before.st_mode) || S_ISLNK(before.st_mode)) return -1;
	const int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
	if (fd < 0) return -1;
	if (fstat(fd, &opened) != 0 || lstat(path, &after) != 0 || !S_ISDIR(after.st_mode) ||
		!same_identity(&before, &opened) || !same_identity(&opened, &after)) { close(fd); return -1; }
	*identity = opened;
	return fd;
}

/* Removes an entry this run created only while its recorded name still has its recorded identity.
 * A refused removal, changed identity, or missing name leaves cleanup unconfirmed. */
static void remove_created_entry(int parent_fd, const char *name, const struct stat *identity, int flags) {
	struct stat current;
	if (fstatat(parent_fd, name, &current, AT_SYMLINK_NOFOLLOW) != 0 || !same_identity(identity, &current) ||
		unlinkat(parent_fd, name, flags) != 0) cleanup_incomplete = 1;
}

static int add_created(CreatedEntry *entries, size_t *count, const char *path, const char *name,
	const struct stat *stat, int parent_fd, int directory) {
	if (*count >= MAX_CREATED_ENTRIES) return 0;
	entries[*count].path = strdup(path);
	entries[*count].name = strdup(name);
	entries[*count].parent_fd = dup(parent_fd);
	if (!entries[*count].path || !entries[*count].name || entries[*count].parent_fd < 0) {
		free(entries[*count].path);
		free(entries[*count].name);
		if (entries[*count].parent_fd >= 0) close(entries[*count].parent_fd);
		return 0;
	}
	entries[*count].dev = stat->st_dev;
	entries[*count].ino = stat->st_ino;
	entries[*count].directory = directory;
	(*count)++;
	return 1;
}

static int open_parent(int root_fd, const char *path, CreatedEntry *created, size_t *created_count, int create, char **name_out) {
	char *copy = strdup(path);
	char *prefix = calloc(strlen(path) + 1, 1);
	if (!copy || !prefix) { free(copy); free(prefix); return -1; }
	int current = dup(root_fd);
	if (current < 0) { free(copy); free(prefix); return -1; }
	char *cursor = copy;
	char *slash;
	while ((slash = strchr(cursor, '/')) != NULL) {
		*slash = 0;
		if (prefix[0]) strcat(prefix, "/");
		strcat(prefix, cursor);
		int next = openat(current, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
		if (next < 0 && errno == ENOENT && create) {
			if (mkdirat(current, cursor, 0700) != 0) goto fail;
			entries_created = 1;
			struct stat created_stat;
			if (fstatat(current, cursor, &created_stat, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISDIR(created_stat.st_mode)) {
				cleanup_incomplete = 1;
				goto fail;
			}
			if (!add_created(created, created_count, prefix, cursor, &created_stat, current, 1)) {
				remove_created_entry(current, cursor, &created_stat, AT_REMOVEDIR);
				goto fail;
			}
			next = openat(current, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
		}
		if (next < 0) goto fail;
		struct stat stat;
		if (fstat(next, &stat) != 0 || !S_ISDIR(stat.st_mode)) { close(next); goto fail; }
		close(current);
		current = next;
		cursor = slash + 1;
	}
	*name_out = strdup(cursor);
	free(copy);
	free(prefix);
	if (!*name_out) { close(current); return -1; }
	return current;
fail:
	close(current);
	free(copy);
	free(prefix);
	return -1;
}

static int stat_relative(int root_fd, const char *path, struct stat *result, int *parent_out, char **name_out) {
	CreatedEntry unused[1];
	size_t unused_count = 0;
	int parent = open_parent(root_fd, path, unused, &unused_count, 0, name_out);
	if (parent < 0) return 0;
	if (fstatat(parent, *name_out, result, AT_SYMLINK_NOFOLLOW) != 0) { close(parent); free(*name_out); return 0; }
	*parent_out = parent;
	return 1;
}

static void rollback(int root_fd, CreatedEntry *entries, size_t count) {
	(void)root_fd;
	while (count > 0) {
		CreatedEntry *entry = &entries[--count];
		const struct stat identity = { .st_dev = entry->dev, .st_ino = entry->ino };
		remove_created_entry(entry->parent_fd, entry->name, &identity, entry->directory ? AT_REMOVEDIR : 0);
	}
}

static int verify_entries(int root_fd, CreatedEntry *entries, size_t count) {
	for (size_t index = 0; index < count; index++) {
		struct stat current;
		int parent;
		char *name = NULL;
		if (!stat_relative(root_fd, entries[index].path, &current, &parent, &name)) return 0;
		const int ok = current.st_dev == entries[index].dev && current.st_ino == entries[index].ino &&
			(entries[index].directory ? S_ISDIR(current.st_mode) : S_ISREG(current.st_mode));
		close(parent);
		free(name);
		if (!ok) return 0;
	}
	return 1;
}

static int extract_files(int root_fd, InputFile *files, uint32_t count, CreatedEntry *created, size_t *created_count) {
	for (uint32_t index = 0; index < count; index++) {
		char *name = NULL;
		const int parent = open_parent(root_fd, files[index].path, created, created_count, 1, &name);
		if (parent < 0) return 0;
		const int fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
		if (fd < 0) { close(parent); free(name); return 0; }
		entries_created = 1;
		struct stat stat;
		if (fstat(fd, &stat) != 0) {
			cleanup_incomplete = 1;
			close(fd); close(parent); free(name); return 0;
		}
		if (!S_ISREG(stat.st_mode)) {
			close(fd); remove_created_entry(parent, name, &stat, 0); close(parent); free(name); return 0;
		}
		if (!add_created(created, created_count, files[index].path, name, &stat, parent, 0)) {
			close(fd); remove_created_entry(parent, name, &stat, 0); close(parent); free(name); return 0;
		}
		size_t offset = 0;
		while (offset < files[index].size) {
			const ssize_t written = write(fd, files[index].content + offset, files[index].size - offset);
			if (written < 0 && errno == EINTR) continue;
			if (written <= 0) { close(fd); close(parent); free(name); return 0; }
			offset += (size_t)written;
		}
		struct stat after;
		const int ok = fstat(fd, &after) == 0 && same_identity(&stat, &after) && S_ISREG(after.st_mode);
		close(fd);
		close(parent);
		free(name);
		if (!ok) return 0;
	}
	return 1;
}

/* Exit status: 0 committed; otherwise 2 when nothing was created, 3 when every created entry was
 * removed, and 4 when an entry this run created could not be confirmed removed. */
int main(int argc, char **argv) {
	if (argc != 4) return 2;
	char *dev_end = NULL;
	char *ino_end = NULL;
	const unsigned long long expected_dev = strtoull(argv[2], &dev_end, 10);
	const unsigned long long expected_ino = strtoull(argv[3], &ino_end, 10);
	if (!dev_end || *dev_end || !ino_end || *ino_end) return 2;
	unsigned char *buffer = NULL;
	size_t length = 0;
	InputFile *files = NULL;
	uint32_t file_count = 0;
	if (!read_input(&buffer, &length) || !parse_input(buffer, length, &files, &file_count)) { free(buffer); return 2; }
	CreatedEntry *created = calloc(MAX_CREATED_ENTRIES, sizeof(*created));
	struct stat root_identity;
	const int root_fd = created ? open_root(argv[1], &root_identity) : -1;
	size_t created_count = 0;
	int ok = root_fd >= 0 && (unsigned long long)root_identity.st_dev == expected_dev &&
		(unsigned long long)root_identity.st_ino == expected_ino &&
		extract_files(root_fd, files, file_count, created, &created_count) &&
		verify_entries(root_fd, created, created_count);
	struct stat root_after;
	if (ok && (lstat(argv[1], &root_after) != 0 || !S_ISDIR(root_after.st_mode) || !same_identity(&root_identity, &root_after))) ok = 0;
	if (!ok && root_fd >= 0) rollback(root_fd, created, created_count);
	if (root_fd >= 0) close(root_fd);
	for (size_t index = 0; index < created_count; index++) {
		free(created[index].path);
		free(created[index].name);
		close(created[index].parent_fd);
	}
	for (uint32_t index = 0; index < file_count; index++) free(files[index].path);
	free(created);
	free(files);
	free(buffer);
	return ok ? 0 : cleanup_incomplete ? 4 : entries_created ? 3 : 2;
}
