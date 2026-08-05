//! Kiriko deterministic venue bundle codec.
//!
//! `kvb1` is a content-addressed binary format: a fixed 52-byte envelope
//! (magic, version, flags, uncompressed length, SHA-256) wrapping one
//! deterministic zstd frame around a fixed-width section directory. Given
//! the same normalized venue model, [`encode_bundle`] always produces the
//! same bytes, regardless of source ZIP record order.
//!
//! [`compile_imdf`] is the primary entry point: it imports raw IMDF ZIP
//! bytes through `kiriko-model` and encodes the result as a bundle.
//! [`encode_bundle`]/[`decode_bundle`] operate directly on the in-memory
//! [`BundleDocument`] for round-trip and format-conformance testing.
//!
//! Phase Two Task 3: the `kvb1` bundle codec.

#![deny(rust_2018_idioms)]

mod clip;
mod codec;
mod error;
mod export;
mod format;
mod sections;
mod spatial_section;
mod synth;
#[cfg(feature = "netgen")]
mod synth_medial;

pub use codec::{
    BundleDocument, BundleInspection, BundleMetadata, BundleStats, CapabilityReport,
    CompiledBundle, SectionCapability, compile_imdf, compile_imdf_with_network, decode_bundle,
    encode_bundle, inspect_bundle,
};
pub use error::{BundleError, BundleErrorCode, CompileError};
pub use export::{ExportError, NetworkGeoJson, export_network, ordinal_to_floor_label};
