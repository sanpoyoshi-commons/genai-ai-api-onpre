import type { FileStorage } from '../../lib/storage/fileStorage.js';
import type { StorageBuckets } from '../../lib/storage/config.js';

/** files Router の依存（注入式）。storage は seam（実 SeaweedFS 配線は後続）、buckets は env 由来のバケット名。 */
export interface FilesDeps {
  storage: FileStorage;
  buckets: StorageBuckets;
}
