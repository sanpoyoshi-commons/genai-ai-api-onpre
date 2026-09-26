import type { JudgeService } from '../../lib/judge/judgeService.js';

/** judge Router の依存（注入式＝ユニットテストで fake 差し替え可）。 */
export interface JudgeDeps {
  /** 判定の実行（プロンプト組み立て → 1 トークン目の分布 → 候補への写像）。 */
  judge: JudgeService;
}
