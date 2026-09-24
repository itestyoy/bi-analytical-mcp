// WHAT EACH dbt ENVIRONMENT IS — decided here, by this tool, and nowhere else.
//
// An environment (src/dbt/environments.js) is built ONLY from this list: its name, what it is for,
// and the EXACT top-level packages, per warehouse adapter where the adapter matters. The full
// dependency set of each — every transitive package, pinned, with the SHA-256 of every file — is
// locked in config/dbt-environments/<name>.<adapter>.lock.txt, generated from this list
// (`npm run dbt:env -- lock`) and installed with pip's --require-hashes and --only-binary :all:
// (by a pip that is itself locked), so a build gets exactly the files that were reviewed: no other
// version, no other package, no source build — except the few a spec names in `sourceBuilds`,
// built from their hash-checked source with locked build tools. There is no way to hand the tool
// a requirements file of one's own. Changing a version is a change HERE, followed by `lock`,
// reviewed like any other code.

/** What building a package from source needs — locked like everything else, for sourceBuilds. */
const BUILD_TOOLS = ['setuptools==84.0.0', 'wheel==0.48.0'];

/** The adapters an environment can be built for — the warehouses this server speaks. */
export const ADAPTERS = ['duckdb', 'bigquery'];

export const ENVIRONMENT_SPECS = {
  'dbt-v2': {
    description: 'dbt v2 — the Rust binary. Its warehouse adapters are built in (it fetches their ADBC driver on first use), so there is no adapter package: one environment serves every warehouse.',
    packages: ['dbt==2.0.6'],
    // PyPI's dbt 2.0.6 is a download-at-install sdist: building it runs its own backend, which
    // fetches the platform wheel from dbt Labs' CDN. That backend is never run here. `lock` reads
    // the wheel's URL and SHA-256 from the assets.json inside that sdist (the sdist itself checked
    // against PyPI's digest) and locks the WHEEL, so `create` installs it like any other file.
    wheelsFromSdist: ['dbt'],
  },
  'dbt-v1': {
    description: 'dbt 1.x — the Python dbt-core with the warehouse adapter. On DuckDB it also carries pandas + pyarrow, with which dbt-duckdb runs dbt Python models locally (the python stage; dbt v2 runs none on DuckDB).',
    adapters: {
      duckdb: ['dbt-core==1.11.11', 'dbt-duckdb==1.11.0', 'pandas==3.0.6', 'pyarrow==25.0.1'],
      bigquery: ['dbt-core==1.11.11', 'dbt-bigquery==1.11.3'],
    },
  },
  metricflow: {
    description: "MetricFlow's `mf` and the Python dbt-core + adapter it queries the warehouse with. Every dbt environment queries metrics through it (dbt's docs, without the dbt platform: \"install MetricFlow separately\"). dbt-metricflow 0.13.0 pins metricflow 0.211.0 and caps dbt-core below 1.12.",
    adapters: {
      duckdb: ['dbt-metricflow==0.13.0', 'dbt-core==1.11.11', 'dbt-duckdb==1.11.0', ...BUILD_TOOLS],
      bigquery: ['dbt-metricflow==0.13.0', 'dbt-core==1.11.11', 'dbt-bigquery==1.11.3', ...BUILD_TOOLS],
    },
    // dbt-metricflow requires halo>=0.0.31, published as source only. It is built HERE, from its
    // hash-checked source, with the locked setuptools/wheel above and no build isolation — an
    // isolated build would fetch its build tools from the network, unchecked.
    sourceBuilds: ['halo'],
  },
};

/**
 * The installer itself: the pip every environment is built with, installed first (by the venv's
 * bundled pip, hash-checked), so the build does not depend on whichever pip the Python shipped.
 */
export const INSTALLER = ['pip==26.2.1'];

/**
 * The platform the locks are resolved for: the image's python3 (Debian bookworm) on x86_64 Linux —
 * one version of every package, with the hashes of its files. Another platform is another lock.
 */
export const LOCK_PYTHON = '3.11';
export const LOCK_PLATFORM = 'x86_64-manylinux_2_28';
/** The same platform as a wheel tag — the key a download-at-install sdist's assets.json uses. */
export const LOCK_WHEEL_TAG = 'manylinux_2_28_x86_64';

/** An environment's spec, or a refusal naming what exists. */
export function environmentSpec(name) {
  const spec = ENVIRONMENT_SPECS[name];
  if (!spec) throw new Error(`no dbt environment '${name}' is defined (defined: ${Object.keys(ENVIRONMENT_SPECS).join(', ')}) — environments are declared in src/dbt/environment-specs.js`);
  return spec;
}

/** The exact top-level packages of `name` for `adapter` (the adapter is ignored where none applies). */
export function environmentPackages(name, adapter) {
  const spec = environmentSpec(name);
  if (spec.packages) return spec.packages;
  if (!adapter) throw new Error(`dbt environment '${name}' is built per warehouse adapter — name one: ${Object.keys(spec.adapters).join(', ')}`);
  const pkgs = spec.adapters[adapter];
  if (!pkgs) throw new Error(`dbt environment '${name}' has no '${adapter}' build (adapters: ${Object.keys(spec.adapters).join(', ')})`);
  return pkgs;
}

/** The lock of the installer (pip), relative to the repository root. */
export const INSTALLER_LOCK = 'config/dbt-environments/installer.lock.txt';

/** The lock file of `name` for `adapter`, relative to the repository root. */
export function lockFile(name, adapter) {
  const spec = environmentSpec(name);
  return spec.packages ? `config/dbt-environments/${name}.lock.txt` : `config/dbt-environments/${name}.${adapter}.lock.txt`;
}
