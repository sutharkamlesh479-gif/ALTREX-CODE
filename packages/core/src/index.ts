// @altrex/core — import modules by subpath (e.g. '@altrex/core/workspace/checkpoints').
// This barrel exposes only the stable Phase 1 surface.
export { EventBus, type EventBusOptions, type EventListener } from './events/event-bus'
export { CheckpointError, CheckpointStore, type CheckpointLimits, type CheckpointStoreOptions } from './workspace/checkpoints'
export { IGNORED_DIRECTORIES, isIgnoredDirectory } from './workspace/ignore'
export { safePath } from './security/path-guard'
export { uuidv7 } from './util/uuid'
export { abortableDelay } from './util/abort'
