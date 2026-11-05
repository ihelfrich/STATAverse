import {
  LAB_PROGRESS_KEY,
  emptyLabProgress,
  parseLabProgress,
  validateLabProgress,
  withLabProgressLock,
} from "./lab-progress.js";

/** One local lab record, coalesced writes, and a stale-copy guard shared by labs. */
export class LabProgressSession {
  constructor({
    read = () => localStorage.getItem(LAB_PROGRESS_KEY),
    write = (text) => localStorage.setItem(LAB_PROGRESS_KEY, text),
    lock = withLabProgressLock,
    onStatus = () => {},
  } = {}) {
    this.read = read;
    this.write = write;
    this.lock = lock;
    this.onStatus = onStatus;
    this.value = emptyLabProgress();
    this.raw = null;
    this.canSave = true;
    this.message = "";
    this.revision = 0;
    this.savedRevision = 0;
    this.writing = null;
    try {
      this.raw = read();
      if (this.raw !== null) this.value = parseLabProgress(this.raw);
    } catch {
      this.warn(
        "Lab progress could not be read or saved. Any stored copy has been left in place. You can continue here and export your work.",
      );
    }
    this.storageListener = (event) => {
      if (event.key === LAB_PROGRESS_KEY || event.key === null)
        this.warn(
          "Lab progress changed in another tab. Reload before saving further work so that imported or cleared work is not overwritten. This session remains available for export.",
        );
    };
    globalThis.addEventListener?.("storage", this.storageListener);
  }
  status() {
    return {
      canSave: this.canSave,
      saving: Boolean(this.writing),
      message: this.message,
    };
  }
  warn(message) {
    this.canSave = false;
    this.message = message;
    this.onStatus(this.status());
  }
  update(transform) {
    this.value = validateLabProgress(transform(this.value));
    this.revision++;
    return this.flush();
  }
  flush() {
    if (!this.canSave) return Promise.resolve(false);
    if (this.writing) return this.writing;
    this.writing = this.drain().then((saved) => {
      this.writing = null;
      // A final microtask can edit the draft after drain finishes but before
      // this promise settles. Keep that edit in the same awaited save.
      if (this.canSave && this.savedRevision < this.revision)
        return this.flush();
      this.onStatus(this.status());
      return saved;
    });
    this.onStatus(this.status());
    return this.writing;
  }
  async drain() {
    try {
      while (this.canSave && this.savedRevision < this.revision)
        await this.lock(() => {
          if (!this.canSave || this.read() !== this.raw)
            throw new Error("changed");
          const text = JSON.stringify(this.value);
          this.write(text);
          this.raw = text;
          this.savedRevision = this.revision;
        });
      return this.canSave;
    } catch (error) {
      this.warn(
        error?.message === "changed"
          ? "Lab progress changed in another tab. Reload before saving further work so that imported or cleared work is not overwritten. This session remains available for export."
          : "This browser could not save lab progress. You can continue in this session; export your work before leaving.",
      );
      return false;
    }
  }
  close() {
    globalThis.removeEventListener?.("storage", this.storageListener);
  }
}
