/**
 * 機能 ON/OFF（compose profile 連動）の解決ロジック（api 側）。
 *
 * deploy の nginx entrypoint（docker-compose.yml）と同一仕様で、有効機能を解決する：
 *   1) 明示 ENABLED_USE_CASES（JSON）があればそれを優先（方式 c）。
 *   2) 無ければ COMPOSE_PROFILES から算出（chat 常時 / generate・translate・diagram=llm /
 *      image=image / transcribe=transcribe / rag=embedding / apps=queue）。
 *
 * api は base 常時起動で profile を知らないため、compose が同じ env（COMPOSE_PROFILES / ENABLED_USE_CASES）を
 * 注入する。off の機能ルート（rag/image/transcribe、ExApp 非同期実行=/exapps/invoke）は requireUseCase
 * ミドルウェアが 503 を返し、web のメニュー/実行導線の抑止と整合を取る（「導線だけ生きて壊れる」を防ぐ）。
 */

/** 機能キー（web の EnabledUseCases と同集合）。 */
export type UseCaseKey =
  | 'chat'
  | 'generate'
  | 'translate'
  | 'diagram'
  | 'image'
  | 'transcribe'
  | 'rag'
  | 'apps'
  | 'codeInterpreter';

export type EnabledUseCases = Record<UseCaseKey, boolean>;

/** profile 名（含まれていればその由来機能を点灯）。 */
const profileIncludes = (composeProfiles: string, profile: string): boolean =>
  `,${composeProfiles},`.includes(`,${profile},`);

/**
 * COMPOSE_PROFILES から有効機能を算出（nginx entrypoint の case 判定と同表）。
 * chat は常時 on（base+llm 前提・ゲートしない）。
 */
const fromComposeProfiles = (composeProfiles: string): EnabledUseCases => {
  const llm = profileIncludes(composeProfiles, 'llm');
  return {
    chat: true,
    generate: llm,
    translate: llm,
    diagram: llm,
    image: profileIncludes(composeProfiles, 'image'),
    transcribe: profileIncludes(composeProfiles, 'transcribe'),
    rag: profileIncludes(composeProfiles, 'embedding'),
    apps: profileIncludes(composeProfiles, 'queue'),
    codeInterpreter: profileIncludes(composeProfiles, 'sandbox'),
  };
};

const ALL_KEYS: UseCaseKey[] = [
  'chat',
  'generate',
  'translate',
  'diagram',
  'image',
  'transcribe',
  'rag',
  'apps',
  'codeInterpreter',
];

/** 明示 ENABLED_USE_CASES（部分指定可）を全キーの bool に正規化（未指定キーは false、chat は既定 on）。 */
const normalizeOverride = (parsed: Partial<Record<UseCaseKey, unknown>>): EnabledUseCases => {
  const result = {} as EnabledUseCases;
  for (const key of ALL_KEYS) {
    const v = parsed[key];
    result[key] = typeof v === 'boolean' ? v : key === 'chat';
  }
  return result;
};

/**
 * 有効機能を解決する。ENABLED_USE_CASES（明示・優先）→ COMPOSE_PROFILES（算出）の順。
 * 不正な JSON は無視して profile 算出へフォールバックする（壊さない＝graceful）。
 */
export function resolveEnabledUseCases(env: NodeJS.ProcessEnv = process.env): EnabledUseCases {
  const override = env.ENABLED_USE_CASES?.trim();
  if (override) {
    try {
      const parsed = JSON.parse(override) as Partial<Record<UseCaseKey, unknown>>;
      if (parsed && typeof parsed === 'object') {
        return normalizeOverride(parsed);
      }
    } catch {
      // 不正な JSON は無視（profile 算出へフォールバック）。
    }
  }
  return fromComposeProfiles(env.COMPOSE_PROFILES ?? '');
}
