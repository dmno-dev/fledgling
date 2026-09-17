import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/**
 * PyPI client + minimal-sdist builder — the PyPI analogue of npm.ts / jsr.ts.
 *
 * PyPI differs from both in the ways that shape this module:
 *  - **Trusted publishing can't be configured programmatically.** Every publisher
 *    management route on PyPI is a session + CSRF protected HTML form; the only
 *    machine endpoints (`/_/oidc/audience`, `/_/oidc/mint-token`) *mint* tokens,
 *    they don't manage publishers. So unlike `npm trust` / JSR's `PATCH`, there's
 *    nothing to call — fledgling claims the name and hands you a checklist.
 *  - **There's no create-on-first-publish problem.** A "pending publisher" can be
 *    registered for a project that doesn't exist yet. But it does *not* reserve the
 *    name — anyone else can still take it, which invalidates the pending publisher.
 *    Claiming is what actually locks a name down, which is what this module does.
 *  - **Uploading needs no Python toolchain.** A minimal sdist is a gzipped tar
 *    holding a single PKG-INFO, and PyPI reads the metadata from the multipart
 *    *form fields*, not out of the archive (warehouse/forklift/metadata.py::parse).
 */

export interface PypiRegistry {
  /** Display name, for messages. */
  label: string;
  /** Legacy upload endpoint (twine's `repository-url`). */
  upload: string;
  /** Web/JSON API base — `{index}/pypi/{name}/json` and the management pages. */
  index: string;
}

export const PYPI: PypiRegistry = {
  label: 'PyPI',
  upload: 'https://upload.pypi.org/legacy/',
  index: 'https://pypi.org',
};

export const TEST_PYPI: PypiRegistry = {
  label: 'TestPyPI',
  upload: 'https://test.pypi.org/legacy/',
  index: 'https://test.pypi.org',
};

// PyPI asks API clients to identify themselves with a descriptive User-Agent.
declare const __VERSION__: string;
const USER_AGENT = `fledgling/${typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0'}; https://github.com/dmno-dev/fledgling`;

/** PyPI's project-name shape (warehouse's `PROJECT_NAME_RE`). */
const PROJECT_NAME_RE = /^([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$/;

/**
 * PEP 503 normalization — lowercase, and runs of `.`, `-`, `_` collapse to a single
 * `-`. This is the identity PyPI actually indexes projects by, so `My.Pkg`,
 * `my_pkg` and `my--pkg` are all the same project.
 */
export function normalizePypiName(name: string): string {
  return name.replace(/[-_.]+/g, '-').toLowerCase();
}

/**
 * The filename stem PEP 625 mandates for an sdist: the PEP 503 normalized name with
 * hyphens as underscores. Warehouse rejects anything else outright, comparing against
 * `f"{project.normalized_name.replace('-', '_')}-{version}.tar.gz"`.
 */
export function sdistStem(name: string): string {
  return normalizePypiName(name).replace(/-/g, '_');
}

/** Validate a name's *shape* (availability is a separate check — see `nameStatus`). */
export function validatePypiName(name: string): string | undefined {
  if (!name) return 'Enter a package name';
  if (name.length > 214) return 'Too long — PyPI names are 214 characters max';
  if (name.trim() !== name) return 'No leading or trailing spaces';
  if (!PROJECT_NAME_RE.test(name)) {
    return 'Start and end with a letter or digit; letters, digits, and - . _ in between';
  }
  return undefined;
}

/**
 * Validate a placeholder version. Deliberately stricter than PEP 440: warehouse builds
 * the expected filename from the *canonicalized* version, so anything PEP 440 would
 * rewrite (`1.0-alpha` → `1.0a0`, `01.0` → `1.0`) would fail the filename check with a
 * confusing error. Plain dotted release segments are their own canonical form.
 */
export function validatePypiVersion(version: string): string | undefined {
  if (!/^(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/.test(version)) {
    return `"${version}" isn't usable as a placeholder version — use plain dotted numbers like 0.0.0 (no pre-release suffixes or leading zeros)`;
  }
  return undefined;
}

// --- minimal sdist ------------------------------------------------------------

/** A tar member: a regular file, or a directory (no data, path ends with `/`). */
interface TarEntry {
  path: string;
  data?: Buffer;
  dir?: boolean;
}

/** One 512-byte ustar header. Fields are NUL-terminated octal, per POSIX tar. */
function tarHeader(entry: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512);
  const write = (s: string, off: number, len: number) => h.write(s.slice(0, len), off, len, 'utf8');
  const octal = (n: number, off: number, len: number) => write(n.toString(8).padStart(len - 1, '0') + '\0', off, len);

  write(entry.path, 0, 100);
  octal(entry.dir ? 0o755 : 0o644, 100, 8); // mode
  octal(0, 108, 8); // uid
  octal(0, 116, 8); // gid
  octal(size, 124, 12);
  octal(0, 136, 12); // mtime — 0 keeps the archive byte-for-byte reproducible
  h.fill(' ', 148, 156); // checksum is summed with this field blank…
  write(entry.dir ? '5' : '0', 156, 1); // typeflag
  write('ustar', 257, 6); // magic (the 6th byte stays NUL)
  write('00', 263, 2); // version
  write('root', 265, 32); // uname
  write('root', 297, 32); // gname

  let sum = 0;
  for (const b of h) sum += b;
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8); // …then written back as 6 octal digits
  return h;
}

/** A tar archive of `entries`, padded to 512-byte blocks and closed with two zero blocks. */
function tar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    parts.push(tarHeader(entry, data.length));
    if (data.length) {
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export interface SdistMeta {
  name: string;
  version: string;
  summary: string;
}

export interface Sdist extends SdistMeta {
  filename: string;
  /**
   * A plain Uint8Array rather than a Buffer, so it drops straight into a `Blob`
   * (Buffer's backing store is `ArrayBufferLike`, which `BlobPart` won't accept).
   */
  bytes: Uint8Array<ArrayBuffer>;
  /** Hex SHA-256 of `bytes` — PyPI requires a digest in the upload form. */
  sha256: string;
}

/**
 * Build the smallest sdist PyPI accepts: a gzipped tar holding `{stem}-{version}/`
 * and a single `PKG-INFO` inside it. The PKG-INFO mirrors the upload form fields
 * exactly, so it doesn't matter which of the two PyPI ends up parsing.
 *
 * The directory member is load-bearing, not decoration. Warehouse locates the sdist
 * root with `os.path.commonpath(tar.getnames())` and then requires `{root}/PKG-INFO`
 * — and `commonpath` of a *single* path returns that whole path, so a lone
 * `foo-0.0.0/PKG-INFO` makes warehouse look for `foo-0.0.0/PKG-INFO/PKG-INFO` and
 * reject the upload. Two members make the common prefix the directory, as it is in
 * any real sdist.
 */
export function buildSdist(meta: SdistMeta): Sdist {
  const stem = sdistStem(meta.name);
  const dir = `${stem}-${meta.version}`;
  const pkgInfo = [
    'Metadata-Version: 2.1',
    `Name: ${meta.name}`,
    `Version: ${meta.version}`,
    `Summary: ${meta.summary}`,
    '',
  ].join('\n');
  const gz = gzipSync(
    tar([
      { path: `${dir}/`, dir: true },
      { path: `${dir}/PKG-INFO`, data: Buffer.from(pkgInfo, 'utf8') },
    ]),
    { level: 9 },
  );
  const bytes = new Uint8Array(gz);
  return {
    ...meta,
    filename: `${dir}.tar.gz`,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

// --- client -------------------------------------------------------------------

export interface PypiResponse {
  status: number;
  ok: boolean;
  body: string;
}

/** Is the name claimed? `unknown` when the registry couldn't be reached. */
export type NameStatus = 'free' | 'taken' | 'unknown';

export interface PypiClient {
  nameStatus(name: string): Promise<NameStatus>;
  upload(dist: Sdist): Promise<PypiResponse>;
}

export function pypiClient(registry: PypiRegistry, token?: string): PypiClient {
  return {
    async nameStatus(name) {
      // The JSON API is the cheapest existence check, but it only catches *exact*
      // (normalized) collisions — see `AVAILABILITY_CAVEAT`.
      try {
        const res = await fetch(`${registry.index}/pypi/${normalizePypiName(name)}/json`, {
          method: 'GET',
          headers: { 'user-agent': USER_AGENT },
        });
        if (res.status === 404) return 'free';
        if (res.ok) return 'taken';
        return 'unknown';
      } catch {
        return 'unknown';
      }
    },

    async upload(dist) {
      const form = new FormData();
      form.set(':action', 'file_upload');
      form.set('protocol_version', '1');
      // Core metadata, as the lowercased/underscored form fields warehouse expects.
      form.set('metadata_version', '2.1');
      form.set('name', dist.name);
      form.set('version', dist.version);
      form.set('summary', dist.summary);
      // File metadata.
      form.set('filetype', 'sdist');
      form.set('pyversion', 'source');
      form.set('sha256_digest', dist.sha256);
      form.set('content', new Blob([dist.bytes], { type: 'application/octet-stream' }), dist.filename);

      // PyPI API tokens authenticate as HTTP Basic with the literal user `__token__`.
      const auth = Buffer.from(`__token__:${token ?? ''}`).toString('base64');
      try {
        const res = await fetch(registry.upload, {
          method: 'POST',
          headers: { authorization: `Basic ${auth}`, 'user-agent': USER_AGENT },
          body: form,
        });
        return { status: res.status, ok: res.ok, body: (await res.text()).trim() };
      } catch (e) {
        return { status: 0, ok: false, body: (e as Error).message };
      }
    },
  };
}

/** A short human reason from an upload failure — PyPI's errors are plain text. */
export function pypiErrorReason(res: PypiResponse): string {
  if (res.status === 403) {
    return `${res.body || 'Forbidden'}\n(a 403 usually means the token is wrong/revoked, or the account is missing a verified email or 2FA)`;
  }
  // Warehouse prefixes many 400s with the HTML error page title; keep the first lines.
  const body = res.body.split('\n').slice(0, 4).join('\n');
  return body || `HTTP ${res.status}`;
}

/** Do PyPI API tokens look like this? (Format check only — the server is authoritative.) */
export function looksLikeToken(token: string): boolean {
  return token.startsWith('pypi-');
}

/**
 * Why a "free" result isn't a promise. PyPI rejects names on rules none of which are
 * queryable: PEP 503 normalization, "ultranormalization" (strip `.-_`, `l`/`i`→`1`,
 * `o`→`0` — so `my-lib` and `myl1b` collide), a prohibited-names list, stdlib
 * collisions, and a typosquatting corpus. `check_project_name` only runs on submit.
 */
export const AVAILABILITY_CAVEAT =
  'PyPI also blocks names that merely *resemble* an existing one: it strips . - _ and\n' +
  'reads l/i as 1 and o as 0, so "my-lib" and "myl1b" collide. Stdlib names and typosquats\n' +
  "are blocked too. None of that is queryable up front — you'll find out on upload.";

/** The trusted-publishing settings page for a project that exists. */
export function publishingSettingsUrl(registry: PypiRegistry, name: string): string {
  return `${registry.index}/manage/project/${normalizePypiName(name)}/settings/publishing/`;
}

/** The pending-publisher page — for projects that don't exist yet (max 3 at a time). */
export function pendingPublisherUrl(registry: PypiRegistry): string {
  return `${registry.index}/manage/account/publishing/`;
}
