import type { FileStorage } from '../../lib/storage/fileStorage.js';
import type { StorageBuckets } from '../../lib/storage/config.js';
import type { ExAppRepository } from '../../repositories/exAppRepository.js';
import type { InvokeHistoryRepository } from '../../repositories/invokeHistoryRepository.js';
import type { TeamRepository } from '../../repositories/teamRepository.js';

/**
 * invokeHistories Router の依存（注入式）。履歴参照系は存在ガード（teams/exApps）＋履歴リポジトリ、
 * getArtifactFile はストレージ seam（artifacts バケット）を使う。
 */
export interface InvokeHistoriesDeps {
  teams: Pick<TeamRepository, 'findById'>;
  exApps: Pick<ExAppRepository, 'findById'>;
  histories: Pick<InvokeHistoryRepository, 'listByScope' | 'findByKey'>;
  storage: FileStorage;
  buckets: StorageBuckets;
}
