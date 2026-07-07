// RTK port constants (mirror Rust defaults)
export const RAW_CAP = 10 * 1024 * 1024;      // 10 MiB
export const MIN_COMPRESS_SIZE = 500;          // bytes; skip tiny blobs
export const DETECT_WINDOW = 1024;             // autodetect peeks first N chars
export const GIT_DIFF_HUNK_MAX_LINES = 100;    // per-hunk line cap
export const GIT_DIFF_CONTEXT_KEEP = 3;        // context lines around changes
export const GIT_LOG_MAX_LINES = 200;          // gitLog line cap
export const DEDUP_LINE_MAX = 2000;            // dedupLog truncation cap

// Rust pipe_cmd.rs parity caps
export const GREP_PER_FILE_MAX = 10;           // match rust: matches.iter().take(10)
export const FIND_PER_DIR_MAX = 10;            // match rust: files.iter().take(10)
export const FIND_TOTAL_DIR_MAX = 20;          // match rust: dirs.iter().take(20)

// git status caps (rust config::limits())
export const STATUS_MAX_FILES = 10;            // config::limits().status_max_files
export const STATUS_MAX_UNTRACKED = 10;        // config::limits().status_max_untracked

// ls compact_ls (rtk/src/cmds/system/ls.rs)
export const LS_EXT_SUMMARY_TOP = 5;           // top-N extensions in summary
export const LS_NOISE_DIRS = [
  "node_modules", ".git", "target", "__pycache__",
  ".next", "dist", "build", ".cache", ".turbo",
  ".vercel", ".pytest_cache", ".mypy_cache", ".tox",
  ".venv", "venv",
  "env", // Python legacy virtualenv; .env (dotenv) intentionally excluded
  "coverage", ".nyc_output", ".DS_Store", "Thumbs.db",
  ".idea", ".vscode", ".vs", "*.egg-info", ".eggs"
];

// tree filter_tree_output cap (no rust cap, we add one to be safe)
export const TREE_MAX_LINES = 200;

// Cursor Glob "Result of search in '...' (total N files):" list
export const SEARCH_LIST_PER_DIR_MAX = 10;
export const SEARCH_LIST_TOTAL_DIR_MAX = 20;

// Smart truncate (port of filter.rs smart_truncate fallback)
export const SMART_TRUNCATE_HEAD = 120;        // lines kept from top
export const SMART_TRUNCATE_TAIL = 60;         // lines kept from bottom
export const SMART_TRUNCATE_MIN_LINES = 250;

// Scored truncate (importance-based fallback, replaces smart-truncate as default)
export const SCORED_HEAD = 40;              // lines kept from top
export const SCORED_TAIL = 30;              // lines kept from bottom
export const SCORED_MIN_LINES = 150;       // only kick in above this
export const SCORED_THRESHOLD = 2;         // minimum score to keep a middle line
export const SCORED_MAX_KEEP = 200;        // hard cap on total output lines

// Progressive compression (age-based cross-message): recent tool results
// kept lighter, old tool results compressed harder. age = distance from
// the latest message in the conversation.
export const AGE_LIGHT_TURNS = 3;            // last N msgs: skip unless large
export const AGE_HEAVY_TURNS = 10;           // N+ turns back: aggressive
export const AGE_LIGHT_MIN_BYTES = 50_000;   // recent: only compress above this
export const AGE_HEAVY_MIN_BYTES = 2_000;    // old: compress even small results
export const AGE_HEAVY_RECOMPRESS_BYTES = 20_000; // old+still large -> 2nd pass

// readNumbered (files with "  N|content" lines, e.g. Cursor read_file)
export const READ_NUMBERED_MIN_HIT_RATIO = 0.7;

// Filter name strings (Rust parity + JS extras)
export const FILTERS = {
  GIT_DIFF: "git-diff",
  GIT_STATUS: "git-status",
  GIT_LOG: "git-log",
  GREP: "grep",
  FIND: "find",
  LS: "ls",
  TREE: "tree",
  DEDUP_LOG: "dedup-log",
  SMART_TRUNCATE: "smart-truncate",
  SCORED_TRUNCATE: "scored-truncate",
  READ_NUMBERED: "read-numbered",
  SEARCH_LIST: "search-list",
  BUILD_OUTPUT: "build-output"
};
