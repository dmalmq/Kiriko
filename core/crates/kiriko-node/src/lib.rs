//! Native Node.js bindings for Kiriko venue compilation.
//!
//! `compileImdf` runs the `kiriko-model` importer and `kiriko-bundle` codec
//! off the Node.js event loop via `napi::bindgen_prelude::AsyncTask`. Every
//! domain failure (a rejected IMDF archive or a bundle-codec error) is
//! converted into the structured [`NativeCompileResponse`] value; a thrown
//! `napi::Error` is reserved for bridge/runtime failures the caller cannot
//! recover from as data.
//!
//! Auxiliary structured data (`stats`, `warnings`, `error`) crosses the
//! bridge as JSON strings so this binding never needs a hand-written
//! `#[napi(object)]` mirror of every `kiriko-model`/`kiriko-bundle` domain
//! type; the compiled bundle itself is the only large payload and crosses
//! as a native `Buffer`.
//!
//! Phase Two Task 4: native compiler binding.

#![deny(rust_2018_idioms)]

#[macro_use]
extern crate napi_derive;

use kiriko_bundle::{
    BundleError, BundleMetadata, CompileError, CompiledBundle, ExportError,
    compile_imdf_with_network, decode_bundle, export_network as export_network_pure,
    inspect_bundle as inspect_bundle_pure, scene_projection as scene_projection_pure,
};
use kiriko_model::model::ViewerWarning;
use kiriko_model::scene::{
    ActivationState, ContextualClassification, FloorMapping, OcclusionClass,
    SourceObjectAssociation, TilesDescriptor,
};
use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Result, Task};
use serde_json::{Map, Value, json};

/// JS-facing discriminated compile result. `ok` selects which of the
/// remaining fields are populated: success carries `bundle`, `statsJson`,
/// and `warningsJson`; failure carries `errorJson` (`{ code, message,
/// details? }`).
#[napi(object)]
pub struct NativeCompileResponse {
    pub ok: bool,
    pub bundle: Option<Buffer>,
    pub stats_json: Option<String>,
    pub warnings_json: Option<String>,
    pub error_json: Option<String>,
}

/// Outcome of the blocking compile step, computed off the event loop. Every
/// variant is `Ok` from `Task::compute`'s perspective: a rejected IMDF
/// archive is domain data, not a bridge failure.
pub enum CompileOutcome {
    Success(CompiledBundle),
    Failure(CompileError),
    /// The request itself could not be read — a malformed tiles descriptor,
    /// which is the caller's bug rather than the archive's.
    Rejected(String),
}

pub struct CompileTask {
    source: Vec<u8>,
    dataset_id: String,
    version: u32,
    network_junctions_geojson: Option<String>,
    network_paths_geojson: Option<String>,
    facilities_geojson: Option<String>,
    synthesize_network: Option<bool>,
    clip_to_venue: Option<bool>,
    tiles_descriptor_json: Option<String>,
}

#[napi]
impl Task for CompileTask {
    type Output = CompileOutcome;
    type JsValue = NativeCompileResponse;

    fn compute(&mut self) -> Result<Self::Output> {
        let metadata = BundleMetadata {
            dataset_id: self.dataset_id.clone(),
            version: self.version,
        };
        let descriptor = match self.tiles_descriptor_json.as_deref().map(parse_descriptor) {
            Some(Ok(descriptor)) => Some(descriptor),
            Some(Err(message)) => {
                return Ok(CompileOutcome::Rejected(
                    json!({ "code": "malformed_tiles_descriptor", "message": message }).to_string(),
                ));
            }
            None => None,
        };
        Ok(
            match compile_imdf_with_network(
                &self.source,
                metadata,
                self.network_junctions_geojson.as_deref(),
                self.network_paths_geojson.as_deref(),
                self.facilities_geojson.as_deref(),
                self.synthesize_network.unwrap_or(false),
                self.clip_to_venue.unwrap_or(false),
                None,
                &[],
                None,
                descriptor.as_ref(),
            ) {
                Ok(compiled) => CompileOutcome::Success(compiled),
                Err(err) => CompileOutcome::Failure(err),
            },
        )
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(match output {
            CompileOutcome::Success(compiled) => success_response(compiled),
            CompileOutcome::Failure(err) => failure_response(&err),
            CompileOutcome::Rejected(error_json) => NativeCompileResponse {
                ok: false,
                bundle: None,
                stats_json: None,
                warnings_json: None,
                error_json: Some(error_json),
            },
        })
    }
}

fn success_response(compiled: CompiledBundle) -> NativeCompileResponse {
    let stats = json!({
        "levels": compiled.stats.levels,
        "features": compiled.stats.features,
    });
    let warnings: Vec<Value> = compiled.warnings.iter().map(warning_json).collect();
    NativeCompileResponse {
        ok: true,
        bundle: Some(compiled.bytes.into()),
        stats_json: Some(stats.to_string()),
        warnings_json: Some(Value::Array(warnings).to_string()),
        error_json: None,
    }
}

fn failure_response(err: &CompileError) -> NativeCompileResponse {
    NativeCompileResponse {
        ok: false,
        bundle: None,
        stats_json: None,
        warnings_json: None,
        error_json: Some(error_json(err).to_string()),
    }
}

fn warning_json(warning: &ViewerWarning) -> Value {
    let mut obj = Map::new();
    obj.insert("code".to_string(), json!(warning.code.as_str()));
    obj.insert("message".to_string(), json!(warning.message));
    if let Some(feature_id) = &warning.feature_id {
        obj.insert("featureId".to_string(), json!(feature_id));
    }
    if let Some(archive_entry) = &warning.archive_entry {
        obj.insert("archiveEntry".to_string(), json!(archive_entry));
    }
    Value::Object(obj)
}

fn error_json(err: &CompileError) -> Value {
    let mut obj = Map::new();
    match err {
        CompileError::Import(e) => {
            obj.insert("code".to_string(), json!(e.code.as_str()));
            obj.insert("message".to_string(), json!(e.message));
            if !e.details.is_empty() {
                let details: Map<String, Value> = e
                    .details
                    .iter()
                    .map(|(k, v)| (k.clone(), json!(v)))
                    .collect();
                obj.insert("details".to_string(), Value::Object(details));
            }
        }
        CompileError::Bundle(e) => {
            obj.insert("code".to_string(), json!(e.code.as_str()));
            obj.insert("message".to_string(), json!(e.message));
        }
        CompileError::Route(e) => {
            obj.insert("code".to_string(), json!("route_build_failed"));
            obj.insert("message".to_string(), json!(e.message));
        }
        CompileError::Facility(e) => {
            obj.insert("code".to_string(), json!("facility_build_failed"));
            obj.insert("message".to_string(), json!(e.message));
        }
    }
    Value::Object(obj)
}

/// The activated tile package's §9 descriptor as the server stores it: hashes
/// as lowercase hex, activation state as a stable string. `kiriko-model`'s
/// canonical types carry no serde derives by design, so the JSON shape is
/// spelled out here rather than leaking a wire format into the domain.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TilesDescriptorDto {
    package_hash: String,
    manifest_hash: String,
    activation_state: String,
    registration_profile_id: String,
    #[serde(default)]
    floor_mappings: Vec<FloorMappingDto>,
    #[serde(default)]
    source_object_associations: Vec<SourceObjectAssociationDto>,
    #[serde(default)]
    contextual_classifications: Vec<ContextualClassificationDto>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FloorMappingDto {
    canonical_level_id: String,
    composite_source_levels: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceObjectAssociationDto {
    source_object_id: String,
    canonical_feature_id: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextualClassificationDto {
    source_object_id: String,
    occlusion: String,
}

fn parse_descriptor(json: &str) -> std::result::Result<TilesDescriptor, String> {
    let dto: TilesDescriptorDto = serde_json::from_str(json).map_err(|e| e.to_string())?;
    Ok(TilesDescriptor {
        package_hash: parse_hash(&dto.package_hash, "packageHash")?,
        manifest_hash: parse_hash(&dto.manifest_hash, "manifestHash")?,
        activation_state: match dto.activation_state.as_str() {
            "activated" => ActivationState::Activated,
            "notActivated" => ActivationState::NotActivated,
            other => return Err(format!("unknown activationState {other:?}")),
        },
        registration_profile_id: dto.registration_profile_id,
        floor_mappings: dto
            .floor_mappings
            .into_iter()
            .map(|mapping| FloorMapping {
                canonical_level_id: mapping.canonical_level_id,
                composite_source_levels: mapping.composite_source_levels,
            })
            .collect(),
        source_object_associations: dto
            .source_object_associations
            .into_iter()
            .map(|association| SourceObjectAssociation {
                source_object_id: association.source_object_id,
                canonical_feature_id: association.canonical_feature_id,
            })
            .collect(),
        contextual_classifications: dto
            .contextual_classifications
            .into_iter()
            .map(|classification| {
                Ok(ContextualClassification {
                    source_object_id: classification.source_object_id,
                    occlusion: match classification.occlusion.as_str() {
                        "opaque" => OcclusionClass::Opaque,
                        "semi_transparent" => OcclusionClass::SemiTransparent,
                        "transparent" => OcclusionClass::Transparent,
                        other => return Err(format!("unknown occlusion {other:?}")),
                    },
                })
            })
            .collect::<std::result::Result<Vec<_>, String>>()?,
    })
}

fn parse_hash(hex: &str, what: &str) -> std::result::Result<[u8; 32], String> {
    if hex.len() != 64 {
        return Err(format!("{what} must be 64 hex characters"));
    }
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
            .map_err(|_| format!("{what} is not hexadecimal"))?;
    }
    Ok(out)
}

/// Compile raw IMDF ZIP `source` bytes into a `kvb1` bundle identified by
/// `dataset_id`/`version`. When both optional network GeoJSON strings are
/// provided, a route graph is built and embedded as bundle section 5; a
/// malformed network is a domain failure. When the optional facilities
/// GeoJSON string is provided, point facilities are built (anchored to the
/// route graph when one exists) and embedded as bundle section 7. Runs
/// entirely off the Node.js event loop via `AsyncTask`; the returned promise
/// always resolves to a [`NativeCompileResponse`], never rejecting for
/// domain (IMDF, route-build, facility-build, or bundle-codec) failures.
// Positional napi FFI signature mirrored by the TS bridge; grouping args
// into a struct would change the JS-facing API.
#[allow(clippy::too_many_arguments)]
#[napi]
pub fn compile_imdf(
    source: Buffer,
    dataset_id: String,
    version: u32,
    network_junctions_geojson: Option<String>,
    network_paths_geojson: Option<String>,
    facilities_geojson: Option<String>,
    synthesize_network: Option<bool>,
    clip_to_venue: Option<bool>,
    tiles_descriptor_json: Option<String>,
) -> AsyncTask<CompileTask> {
    AsyncTask::new(CompileTask {
        source: source.to_vec(),
        dataset_id,
        version,
        network_junctions_geojson,
        network_paths_geojson,
        facilities_geojson,
        synthesize_network,
        clip_to_venue,
        tiles_descriptor_json,
    })
}

/// JS-facing discriminated inspection result. `ok` selects which of the
/// remaining fields are populated: success carries `inspectionJson` (a
/// serialized `kiriko_bundle::BundleInspection`); failure carries
/// `errorJson` (`{ code, message }`).
#[napi(object)]
pub struct NativeInspectResponse {
    pub ok: bool,
    pub inspection_json: Option<String>,
    pub error_json: Option<String>,
}

/// Outcome of the blocking inspection step, computed off the event loop.
/// Both variants carry pre-serialized JSON so decode, hash, *and*
/// serialization all run on the thread pool and `resolve` only wraps
/// strings; a rejected bundle is domain data, not a bridge failure.
pub enum InspectOutcome {
    Success(String),
    Failure(String),
}

pub struct InspectTask {
    bundle: Vec<u8>,
}

#[napi]
impl Task for InspectTask {
    type Output = InspectOutcome;
    type JsValue = NativeInspectResponse;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(match inspect_bundle_pure(&self.bundle) {
            Ok(inspection) => {
                let json = serde_json::to_string(&inspection).map_err(|e| {
                    napi::Error::from_reason(format!("serialize bundle inspection: {e}"))
                })?;
                InspectOutcome::Success(json)
            }
            Err(err) => InspectOutcome::Failure(bundle_error_json(&err).to_string()),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(match output {
            InspectOutcome::Success(inspection_json) => NativeInspectResponse {
                ok: true,
                inspection_json: Some(inspection_json),
                error_json: None,
            },
            InspectOutcome::Failure(error_json) => NativeInspectResponse {
                ok: false,
                inspection_json: None,
                error_json: Some(error_json),
            },
        })
    }
}

fn bundle_error_json(err: &BundleError) -> Value {
    let mut obj = Map::new();
    obj.insert("code".to_string(), json!(err.code.as_str()));
    obj.insert("message".to_string(), json!(err.message));
    Value::Object(obj)
}

/// Inspect immutable `kvb1` `bundle` bytes: decode once, validate
/// level/feature relationships, and project the whole-file SHA-256 plus the
/// level/feature anchor index. Runs entirely off the Node.js event loop via
/// `AsyncTask` (the incoming `Buffer` is copied once into an owned
/// `Vec<u8>` at this binding boundary, matching `CompileTask`); the
/// returned promise always resolves to a [`NativeInspectResponse`], never
/// rejecting for domain (bundle-codec or semantic) failures.
#[napi]
pub fn inspect_bundle(bundle: Buffer) -> AsyncTask<InspectTask> {
    AsyncTask::new(InspectTask {
        bundle: bundle.to_vec(),
    })
}

/// JS-facing discriminated scene-projection result. Success carries
/// `projectionJson` (a serialized `kiriko_bundle::scene_projection`);
/// failure carries `errorJson` (`{ code, message }`).
#[napi(object)]
pub struct NativeSceneProjectionResponse {
    pub ok: bool,
    pub projection_json: Option<String>,
    pub error_json: Option<String>,
}

/// Outcome of the blocking scene-projection step, computed off the event
/// loop; both variants carry pre-serialized JSON (see [`InspectOutcome`]).
pub enum SceneProjectionOutcome {
    Success(String),
    Failure(String),
}

pub struct SceneProjectionTask {
    bundle: Vec<u8>,
}

#[napi]
impl Task for SceneProjectionTask {
    type Output = SceneProjectionOutcome;
    type JsValue = NativeSceneProjectionResponse;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(match decode_bundle(&self.bundle) {
            Ok(document) => {
                let projection = scene_projection_pure(&document);
                let json = serde_json::to_string(&projection).map_err(|e| {
                    napi::Error::from_reason(format!("serialize scene projection: {e}"))
                })?;
                SceneProjectionOutcome::Success(json)
            }
            Err(err) => SceneProjectionOutcome::Failure(bundle_error_json(&err).to_string()),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(match output {
            SceneProjectionOutcome::Success(projection_json) => NativeSceneProjectionResponse {
                ok: true,
                projection_json: Some(projection_json),
                error_json: None,
            },
            SceneProjectionOutcome::Failure(error_json) => NativeSceneProjectionResponse {
                ok: false,
                projection_json: None,
                error_json: Some(error_json),
            },
        })
    }
}

/// Project the Generated scene source of immutable `kvb1` `bundle` bytes:
/// the renderer-neutral typed projection (identity, frame, level groups,
/// primitives, capability state), serialized to JSON. Runs off the event
/// loop like [`inspect_bundle`]; the returned promise always resolves to a
/// [`NativeSceneProjectionResponse`], never rejecting for domain failures.
#[napi]
pub fn scene_projection(bundle: Buffer) -> AsyncTask<SceneProjectionTask> {
    AsyncTask::new(SceneProjectionTask {
        bundle: bundle.to_vec(),
    })
}

/// JS-facing discriminated network-export result. Success carries the
/// `net_junction` / `net_path` GeoJSON `FeatureCollection` text; failure
/// carries `errorJson` (`{ code, message }`).
#[napi(object)]
pub struct NativeExportResponse {
    pub ok: bool,
    pub junctions_json: Option<String>,
    pub paths_json: Option<String>,
    pub error_json: Option<String>,
}

pub enum ExportOutcome {
    Success { junctions: String, paths: String },
    Failure(String),
}

pub struct ExportTask {
    bundle: Vec<u8>,
}

#[napi]
impl Task for ExportTask {
    type Output = ExportOutcome;
    type JsValue = NativeExportResponse;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(match export_network_pure(&self.bundle) {
            Ok(net) => ExportOutcome::Success {
                junctions: net.junctions,
                paths: net.paths,
            },
            Err(err) => ExportOutcome::Failure(export_error_json(&err).to_string()),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(match output {
            ExportOutcome::Success { junctions, paths } => NativeExportResponse {
                ok: true,
                junctions_json: Some(junctions),
                paths_json: Some(paths),
                error_json: None,
            },
            ExportOutcome::Failure(error_json) => NativeExportResponse {
                ok: false,
                junctions_json: None,
                paths_json: None,
                error_json: Some(error_json),
            },
        })
    }
}

fn export_error_json(err: &ExportError) -> Value {
    let mut obj = Map::new();
    obj.insert("code".to_string(), json!(err.code()));
    obj.insert("message".to_string(), json!(err.message()));
    Value::Object(obj)
}

/// Export a compiled `kvb1` bundle's §5 routing graph as `net_junction` /
/// `net_path` GeoJSON. Runs off the Node.js event loop via `AsyncTask`; the
/// returned promise always resolves to a [`NativeExportResponse`], never
/// rejecting for domain (bundle-codec or no-graph) failures.
#[napi]
pub fn export_network(bundle: Buffer) -> AsyncTask<ExportTask> {
    AsyncTask::new(ExportTask {
        bundle: bundle.to_vec(),
    })
}

/// JS-facing discriminated tile-package ingestion result. Success carries the
/// serialized [`kiriko_scene::TilePackageReport`]; failure carries the typed
/// refusal as `{ code, ... }` so the producer UI can explain it in either
/// language without parsing prose.
#[napi(object)]
pub struct NativeTilePackageResponse {
    pub ok: bool,
    pub report_json: Option<String>,
    pub error_json: Option<String>,
}

/// Outcome of the blocking package validation, computed off the event loop.
pub enum TilePackageOutcome {
    Success(String),
    Failure(String),
}

pub struct TilePackageTask {
    package: Vec<u8>,
}

#[napi]
impl Task for TilePackageTask {
    type Output = TilePackageOutcome;
    type JsValue = NativeTilePackageResponse;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(match kiriko_scene::validate_tile_package(&self.package) {
            Ok(report) => {
                let json = serde_json::to_string(&report).map_err(|e| {
                    napi::Error::from_reason(format!("serialize tile package report: {e}"))
                })?;
                TilePackageOutcome::Success(json)
            }
            Err(error) => {
                let json = serde_json::to_string(&error).map_err(|e| {
                    napi::Error::from_reason(format!("serialize tile package error: {e}"))
                })?;
                TilePackageOutcome::Failure(json)
            }
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(match output {
            TilePackageOutcome::Success(report_json) => NativeTilePackageResponse {
                ok: true,
                report_json: Some(report_json),
                error_json: None,
            },
            TilePackageOutcome::Failure(error_json) => NativeTilePackageResponse {
                ok: false,
                report_json: None,
                error_json: Some(error_json),
            },
        })
    }
}

/// Validate an uploaded 3D Tiles package: resolve its URI graph inside the
/// archive, refuse anything that escapes it or cannot be decoded, and record
/// every referenced member's content address. Performs no network or filesystem
/// access — the package's bytes are the only input. Runs off the Node.js event
/// loop; the returned promise always resolves to a
/// [`NativeTilePackageResponse`], never rejecting for a refused package.
#[napi]
pub fn ingest_tile_package(package: Buffer) -> AsyncTask<TilePackageTask> {
    AsyncTask::new(TilePackageTask {
        package: package.to_vec(),
    })
}

/// JS-facing discriminated tile-activation result. Success carries the
/// serialized `kiriko_scene::ActivationEvaluation` — the measurements, the
/// registration table, and every gate that blocks; failure carries
/// `{ code, message }` for the inputs that could not be read at all.
#[napi(object)]
pub struct NativeTileActivationResponse {
    pub ok: bool,
    pub evaluation_json: Option<String>,
    pub error_json: Option<String>,
}

/// What the server sends with an activation evaluation. Deserialized here
/// rather than crossing as a dozen positional arguments: the profile alone has
/// eleven fields, and a positional bridge for it would be unreadable at both
/// ends.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileActivationRequest {
    asset_version: String,
    /// The published tileset root transform, column-major, applied unchanged.
    root_transform: [f64; 16],
    integrity_verified: bool,
    capability_profile: Option<String>,
    #[serde(default)]
    contextual_source_objects: std::collections::BTreeSet<String>,
    #[serde(default)]
    profile: kiriko_scene::RegistrationProfile,
}

pub enum TileActivationOutcome {
    Success(String),
    Failure(String),
}

pub struct TileActivationTask {
    bundle: Vec<u8>,
    content: Vec<u8>,
    request_json: String,
}

#[napi]
impl Task for TileActivationTask {
    type Output = TileActivationOutcome;
    type JsValue = NativeTileActivationResponse;

    fn compute(&mut self) -> Result<Self::Output> {
        let request: TileActivationRequest = match serde_json::from_str(&self.request_json) {
            Ok(request) => request,
            Err(error) => {
                return Ok(TileActivationOutcome::Failure(
                    json!({ "code": "malformed_request", "message": error.to_string() })
                        .to_string(),
                ));
            }
        };
        let document = match decode_bundle(&self.bundle) {
            Ok(document) => document,
            Err(error) => {
                return Ok(TileActivationOutcome::Failure(
                    bundle_error_json(&error).to_string(),
                ));
            }
        };
        let Some(spatial) = document.spatial_context.as_ref() else {
            // Without §8 there is no frame to measure in. A venue published
            // before spatial context existed cannot register tiles until it is
            // recompiled, and saying so is better than measuring in a frame
            // that does not exist.
            return Ok(TileActivationOutcome::Failure(
                json!({
                    "code": "no_spatial_context",
                    "message": "the venue version carries no §8 spatial context to register against"
                })
                .to_string(),
            ));
        };
        let transform = kiriko_scene::FrameTransform::from_tileset(
            &request.root_transform,
            &spatial.frame.ecef_origin,
            &spatial.frame.enu_basis_ecef,
        );
        let scene = match kiriko_scene::read_glb(&self.content) {
            Ok(scene) => scene,
            Err(error) => {
                return Ok(TileActivationOutcome::Failure(
                    json!({ "code": "undecodable_content", "message": error.to_string() })
                        .to_string(),
                ));
            }
        };
        let venue: Vec<kiriko_scene::VenueFloor> = kiriko_bundle::venue_floor_geometry(&document)
            .into_iter()
            .map(|floor| kiriko_scene::VenueFloor {
                level_id: floor.level_id,
                ordinal: floor.ordinal,
                plane_z_m: floor.plane_z_m,
                rings: floor.rings,
            })
            .collect();
        let evaluation = kiriko_scene::evaluate_activation(
            &scene,
            &venue,
            &request.profile,
            &kiriko_scene::ActivationInput {
                asset_version: &request.asset_version,
                integrity_verified: request.integrity_verified,
                capability_profile: request.capability_profile.as_deref(),
                contextual_source_objects: &request.contextual_source_objects,
            },
            &transform,
        );
        let json = serde_json::to_string(&evaluation).map_err(|e| {
            napi::Error::from_reason(format!("serialize tile activation evaluation: {e}"))
        })?;
        Ok(TileActivationOutcome::Success(json))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(match output {
            TileActivationOutcome::Success(evaluation_json) => NativeTileActivationResponse {
                ok: true,
                evaluation_json: Some(evaluation_json),
                error_json: None,
            },
            TileActivationOutcome::Failure(error_json) => NativeTileActivationResponse {
                ok: false,
                evaluation_json: None,
                error_json: Some(error_json),
            },
        })
    }
}

/// Measure an ingested tile package against a venue version's own geometry and
/// apply the versioned profile's bands: where each tile level's floor plane
/// resolves to, which canonical floor it maps to, how far off it sits, and
/// every gate that blocks activation.
///
/// `bundle` is the version's compiled `kvb1` bytes — the canonical venue data
/// registration is measured against — and `content` is the package's decoded
/// tile content. Runs off the Node.js event loop; the returned promise always
/// resolves to a [`NativeTileActivationResponse`], never rejecting for a
/// package that fails its gates: a blocked activation is the answer, not an
/// error.
#[napi]
pub fn evaluate_tile_activation(
    bundle: Buffer,
    content: Buffer,
    request_json: String,
) -> AsyncTask<TileActivationTask> {
    AsyncTask::new(TileActivationTask {
        bundle: bundle.to_vec(),
        content: content.to_vec(),
        request_json,
    })
}
