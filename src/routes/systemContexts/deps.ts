import type { SystemContextRepository } from '../../repositories/systemContextRepository.js';

/** systemcontexts Router の依存（注入式＝ユニットテストで fake 差し替え可）。 */
export interface SystemContextsDeps {
  systemContexts: SystemContextRepository;
}
