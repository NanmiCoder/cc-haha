//! Where the committed COM evidence lives, and the normalisation rules it is
//! held to.
//!
//! The captures under `crates/windows/src/tree/testdata/` are produced by
//! `crates/windows/examples/uia_tree_dump.rs` on a developer machine, in the
//! UIA3 COM stack the adapter ships. Earlier dumps taken on the managed stack
//! are not comparable: A2-4 measured the identical Notepad window reporting
//! as 3 nodes against 26 on COM, so they cannot serve as COM expectations.
//!
//! Nothing in CI asserts what the captures contain - that would be an
//! `app/provider` assertion the corpus rules forbid. What is asserted here is the
//! **redaction rule**: a capture that leaks a process id, a provider id, a
//! window handle or a user path is a defect regardless of what tree it holds.
//!
//! Dogfood censuses are deliberately **not** committed and so are not listed
//! here. They run to thousands of lines of JSON and are regenerated on demand
//! by `probes/windows/scratch/run-dogfood.ps1`, so committing them would carry
//! the bulk without the meaning. The redaction rule those files are held to lives
//! with the renderer that applies it, in
//! `crates/windows/examples/uia_tree_dump/render_slots.rs`.

/// The committed dev-box captures, by the target variant each records.
const CAPTURE_FILES: [&str; 2] = ["notepad-com.json", "explorer-com.json"];

#[cfg(test)]
#[path = "captures_tests.rs"]
mod tests;
