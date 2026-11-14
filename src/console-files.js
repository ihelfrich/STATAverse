// The student's own files: which command loads each kind of file, what to
// say about kinds that cannot be read, reading a file in pieces so that a
// large one shows progress, and the shelf in this browser's IndexedDB that
// keeps added files between visits.

/**
 * The largest file the page takes. A browser tab holds a string of about
 * 500 million characters at most, so a larger text file cannot be read at
 * all; a dataset of this size is read in the worker.
 */
export const PAGE_LIMIT = 500_000_000;

const extension = (name) => /\.([^.\\/]+)$/.exec(name)?.[1].toLowerCase() ?? "";

/** The kinds of file the picker offers: those fileKind takes. */
export const ACCEPT =
  ".csv,.tsv,.txt,.dta,.do,.xlsx,.xlsm,.xls,.sav,.zsav,.xpt,.v5xpt,.v8xpt,.xpf,.sas7bdat,text/csv,text/plain";

/**
 * How a file is taken: "dta" is read as a dataset, "text" as text, "do" goes
 * to the do-file editor, and "binary" is kept as bytes for the import command
 * that reads it.
 */
export function fileKind(name) {
  const ext = extension(name);
  if (ext === "dta") return "dta";
  if (ext === "do") return "do";
  if (/^(xlsx|xlsm|xls|sav|zsav|xpt|v5xpt|v8xpt|xpf|sas7bdat)$/.test(ext))
    return "binary";
  return "text";
}

/**
 * The command that loads an added file into memory, as Stata would, or ""
 * for formats.xpf, which holds the value labels import sasxport5 attaches
 * and is not a dataset to load.
 */
export function loadCommand(name) {
  const ext = extension(name),
    file = `"${name}"`;
  if (ext === "xpf") return "";
  if (ext === "dta") return `use ${file}, clear`;
  if (/^(xlsx|xlsm|xls)$/.test(ext))
    return `import excel using ${file}, firstrow clear`;
  if (ext === "sav" || ext === "zsav")
    return `import spss using ${file}, clear`;
  if (ext === "xpt" || ext === "v5xpt")
    return `import sasxport5 ${file}, clear`;
  if (ext === "v8xpt") return `import sasxport8 ${file}, clear`;
  if (ext === "sas7bdat") return `import sas using ${file}, clear`;
  return `import delimited using ${file}, clear`;
}

/** Why a file is not taken, with what to do instead; "" when it is taken. */
export function refusal(name, size) {
  const ext = extension(name);
  if (size > PAGE_LIMIT)
    return `${name} is ${megabytes(size)}, more than a browser tab can hold (the most is ${megabytes(PAGE_LIMIT)}). In Stata, keep the variables and observations you need, save that as a .dta file, and add it.`;
  if (/^(rds|rdata|rda)$/.test(ext))
    return `${name} is an R file, which Stata does not read either. In R, write it out with haven::write_dta(data, "data.dta") or write.csv(), and add that file.`;
  if (/^(parquet|feather|arrow|pkl|pickle|h5|hdf5)$/.test(ext))
    return `${name} cannot be read here or by Stata. Write it out as CSV or as a Stata .dta file (in Python, pandas' to_csv or to_stata) and add that.`;
  if (/^(ods|numbers)$/.test(ext))
    return `${name} cannot be read here or by Stata. Save it as an Excel .xlsx workbook and add that.`;
  if (/^(zip|gz|tgz|7z|rar|bz2|xz)$/.test(ext))
    return `${name} is an archive. Unpack it and add the files inside.`;
  return "";
}

export function megabytes(size) {
  return size >= 1e6
    ? `${(size / 1e6).toFixed(size >= 1e8 ? 0 : 1)} MB`
    : `${Math.max(1, Math.round(size / 1e3))} KB`;
}

/**
 * The bytes of a Blob or File, read in pieces. `progress(loaded, total)` is
 * called as they arrive. Where a Blob has no stream, it is read whole.
 */
export async function readBlob(blob, progress) {
  const total = blob.size;
  if (typeof blob.stream !== "function")
    return new Uint8Array(await blob.arrayBuffer());
  const bytes = new Uint8Array(total),
    reader = blob.stream().getReader();
  let loaded = 0,
    told = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // A file that grew while it was read keeps the part read first.
    bytes.set(value.subarray(0, Math.max(0, total - loaded)), loaded);
    loaded += value.length;
    if (progress && (loaded - told > total / 50 || loaded >= total)) {
      told = loaded;
      progress(Math.min(loaded, total), total);
    }
  }
  return loaded < total ? bytes.subarray(0, loaded) : bytes;
}

/** Text as a browser reads a file as text: UTF-8, with a BOM dropped. */
export function textOf(bytes) {
  return new TextDecoder().decode(bytes);
}

/**
 * Gives a session one added file. `kind` is from fileKind; text with a NUL
 * byte is refused, since it is not text.
 */
export function giveFile(session, name, kind, bytes) {
  if (kind === "dta") return session.addData(name, bytes);
  if (kind === "binary") return session.addBinary(name, bytes);
  // Text is decoded in the session as import delimited's scan decodes it:
  // UTF-8, UTF-16, or Latin-1 and Windows-1252 bytes kept for encoding().
  return session.addFile(name, bytes);
}

// ----- the shelf: added files kept in this browser between visits -----
const STORE = "files";
function request(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
/**
 * The browser's IndexedDB for this site, with one store of files by name:
 * { name, blob, made, at }. Resolves to null where IndexedDB is not
 * available, as in some private windows; the page then keeps files for the
 * visit only.
 */
export async function openShelf(database = "stataverse-console-files") {
  try {
    if (typeof indexedDB === "undefined") return null;
    const open = indexedDB.open(database, 1);
    open.onupgradeneeded = () =>
      open.result.createObjectStore(STORE, { keyPath: "name" });
    const db = await request(open),
      store = (mode) => db.transaction(STORE, mode).objectStore(STORE);
    return {
      async list() {
        const all = await request(store("readonly").getAll());
        return all
          .filter((file) => file && typeof file.name === "string" && file.blob)
          .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      },
      put(name, blob, made = false) {
        return request(
          store("readwrite").put({ name, blob, made, at: Date.now() }),
        );
      },
      remove(name) {
        return request(store("readwrite").delete(name));
      },
    };
  } catch {
    return null;
  }
}
