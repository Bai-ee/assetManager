# HITLOOP Archive POC — Data Model

This document defines conceptual records. SQLite/cloud/Arweave representations may differ but must preserve these identities and relationships.

## Source
Represents a mounted archive source such as Bryan NAS.
Fields: id, label, source_type, mount identity, connection state, created_at, last_seen_at.

## CollectionJob
A user-selected source folder and its processing lifecycle.
Fields: id, source_id, selected_relative_path, state, created_at, started_at, completed_at, counters, pipeline_version, approval state.

## FileLocation
One observed filesystem location.
Fields: id, source_id, collection_job_id, relative_path, filename, extension, size_bytes, mtime, birthtime when available, discovered_at, last_seen_at, stability state, content_asset_id.

## ContentAsset
Unique exact bytes.
Primary content identity: SHA-256.
Fields: id, sha256, size_bytes, mime/media type, processing_state, first_seen_at.

## Observation
Provider/deterministic evidence.
Fields: id, asset_id, provider, model/version, observation_type, normalized payload, raw-response reference, created_at, usage/cost metadata.

## Entity
Generic graph node. Types include PERSON, ARTIST, BRAND, LABEL, PROJECT, EVENT, VENUE, RELEASE, RECORD, CITY, CLIENT, etc.

## Relationship
Typed edge between assets/entities/collections/events. Includes source, confidence, decision provenance, and human-confirmed state.

## JevDecision
Fields: id, subject, taxonomy question/version, candidate choices/probabilities, selected choice, confidence, evidence refs, created_at.

## HumanCorrection
Never overwrite the machine record. Fields: id, target decision/record, previous value, corrected value, actor, timestamp, note.

## ArchivalRecord
Human-approved current interpretation. References observations, Jev decisions, corrections, entities, relationships, source provenance, normalized archive path/name.

## ProviderUsage
Asset/job attributable usage: provider, operation, units, cost if available, currency, timestamp.

## ArweaveRecord
Quote/upload/verification state and transaction references. Includes package/manifest version and content hashes.

## Key invariants
- One ContentAsset may have many FileLocations.
- FileLocation path is provenance, not content identity.
- AI output is evidence/decision history, not immutable truth.
- Final archival interpretation can evolve while original observations remain traceable.
- Public Arweave metadata should not accidentally expose private machine/network details.
