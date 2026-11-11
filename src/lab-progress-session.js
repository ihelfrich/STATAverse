import {
  LAB_PROGRESS_KEY,
  emptyLabProgress,
  parseLabProgress,
  MARKER_WINDOW_MS,
  labProgressMarker,
  stampLabProgress,
  validateLabProgress,
  withLabProgressLock,
} from "./lab-progress.js";

/** One local lab record, coalesced writes, and a stale-copy guard shared by labs. */
export class LabProgressSession {
  constructor({
    read = () => localStorage.getItem(LAB_PROGRESS_KEY),
    write = (text) => localStorage.setItem(LAB_PROGRESS_KEY, text),
    lock = withLabProgressLock,
    marker = labProgressMarker,
    now = () => Date.now(),
    onStatus = () => {},
  } = {}) {
    this.marker = marker;
    this.now = now;
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
      while (this.canSave && this.savedRevision < this.revision) {
        // The lock is held until the attempt settles where the lock waits
        // for its callback; the attempt is awaited here in any case.
        let attempt;
        await this.lock(() => (attempt = this.attempt()));
        await attempt;
      }
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
  /** One write, made while the lock is held. */
  async attempt() {
    const marked = await this.marker.get(),
      revision = this.revision;
    if (!this.canSave || this.read() !== this.raw) throw new Error("changed");
    // localStorage agreed, but this tab may not have received another
    // tab's write yet. A marker from a different write that is still
    // recent means exactly that. An old marker that differs was left
    // behind by a writer that keeps no marker, and is replaced.
    if (
      marked &&
      marked.generation !== this.generation() &&
      this.now() - marked.at < MARKER_WINDOW_MS
    )
      throw new Error("changed");
    const value = stampLabProgress(this.value),
      text = JSON.stringify(value);
    this.write(text);
    this.value = { ...this.value, generation: value.generation };
    this.raw = text;
    this.savedRevision = revision;
    await this.marker.set(value.generation);
  }
  /** The generation of the record this session last read or wrote. */
  generation() {
    try {
      return this.raw === null ? undefined : JSON.parse(this.raw).generation;
    } catch {
      return undefined;
    }
  }
  close() {
    globalThis.removeEventListener?.("storage", this.storageListener);
  }
}
