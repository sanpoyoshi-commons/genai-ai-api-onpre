import type { LawReportPipeline } from '../../lib/lawRag/lawReportPipeline.js';

/** lawRag Router の依存（注入式＝ユニットテストで fake 差し替え可）。 */
export interface LawRagDeps {
  /** 法令レポート生成オーケストレータ（法令名推定→特定→選別→レポート→出典結合）。 */
  pipeline: LawReportPipeline;
}
