//! Kiriko strict canonical IMDF venue model.
//!
//! [`import_imdf`] parses a ZIP of IMDF 1.0.0 GeoJSON into a deterministic
//! [`VenueModel`], using the same strict archive/security contract as the
//! browser's TypeScript local-ZIP worker (`src/imdf/imdf.worker.ts`) and
//! producing the same normalization the viewer renders (`src/imdf/normalizeVenue.ts`).
//!
//! Phase Two Task 2: strict importer + canonical model.

#![deny(rust_2018_idioms)]
#![allow(clippy::module_inception)]

pub mod archive;
pub mod canonical;
pub mod error;
pub mod geometry;
pub mod model;
mod normalize;
pub mod spatial;

pub use error::{ImportError, ImportErrorCode};

use crate::model::VenueModel;

/// Parse and normalize an IMDF ZIP into the canonical [`VenueModel`].
///
/// `source` must be the raw bytes of an Apple IMDF `.zip` archive. Every
/// structural, security, and normalization failure is reported as an
/// [`ImportError`] whose `code.as_str()` matches the existing browser
/// `VenueLoadErrorCode` strings.
pub fn import_imdf(source: &[u8]) -> Result<VenueModel, ImportError> {
    let parsed = archive::parse(source)?;
    normalize::normalize(parsed)
}
