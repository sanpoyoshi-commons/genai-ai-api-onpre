/**
 * 源内 web フロント互換のレスポンス契約型（MIT、genai-web `packages/types/src` のアイデア領域）。
 *
 * 本リポの DB は正規化済み（chatId が PK、createdDate は TIMESTAMPTZ）だが、
 * フロント（genai-web）は DynamoDB 由来の人工物（id="user#<uid>"／createdDate=ms 文字列／
 * chatId="chat#<uuid>"／usecase）を前提に実装されている（例：decomposeId が "chat#" を剥がす）。
 * そこで「内部正規化・境界で源内型整形」方針に従い、API 応答境界でのみ
 * この型へ整形する（src/lib/serialize）。データ移行性は DB スキーマ側が担保し本層と独立。
 */

/** DynamoDB 複合キー（PK=id, SK=createdDate）がフロント型に漏れたもの。 */
export interface PrimaryKey {
  id: string;
  createdDate: string;
}

export interface Chat extends PrimaryKey {
  chatId: string;
  usecase: string;
  title: string;
  updatedDate: string;
}

export interface Pagination<T> {
  data: T[];
  lastEvaluatedKey?: string;
}

export type ListChatsResponse = Pagination<Chat>;

export interface SystemContext extends PrimaryKey {
  systemContextId: string;
  systemContext: string;
  systemContextTitle: string;
}

export type Role = 'system' | 'user' | 'assistant';

export interface ExtraData {
  type: 'image' | 'video' | 'file' | 'json';
  name: string;
  source: {
    type: 's3' | 'base64' | 'json';
    mediaType: string;
    data: string;
  };
}

/** 取得済みメッセージ（PrimaryKey + 属性 + 本文）。 */
export interface RecordedMessage extends PrimaryKey {
  messageId: string;
  usecase: string;
  userId: string;
  feedback: string;
  role: Role;
  content: string;
  trace?: string;
  extraData?: ExtraData[];
  llmType?: string;
}

/** 作成要求のメッセージ（createMessages の body 要素）。 */
export interface ToBeRecordedMessage {
  role: Role;
  content: string;
  trace?: string;
  extraData?: ExtraData[];
  llmType?: string;
  createdDate?: string;
  messageId: string;
  usecase: string;
}

/**
 * チーム管理ドメインの源内 web 互換型（genai-web `packages/types` の Team/TeamUser/ExApp のアイデア領域）。
 * いずれも DynamoDB の pk/sk プレフィックスをフロント型に漏らしていない（PrimaryKey 非継承）ため、
 * serialize 層は単純写像でよい（Chat の user#／chat# のような接頭辞付与は不要）。createdDate/updatedDate
 * は源内同様エポックミリ秒文字列で返す（内部は TIMESTAMPTZ、境界で String(getTime())）。
 */
/**
 * β 外部依存群（predict/image/transcribe）の源内 web 互換型（genai-web `packages/types/src` のアイデア領域、MIT）。
 * いずれもフロント契約型。実バックエンド（LLM/画像/文字起こし）は seam（src/lib/llm・image・transcription）で注入する。
 */

/** LLM 推論モデル指定。type はクラウド由来語彙だがフロント契約のため維持（ローカルは LLM_BACKEND が経路を決める）。 */
export interface Model {
  type: 'bedrock' | 'sagemaker';
  modelId: string;
  sessionId?: string;
}

/** 未記録メッセージ（predict 入力の messages 要素）。 */
export interface UnrecordedMessage {
  role: Role;
  content: string;
  trace?: string;
  extraData?: ExtraData[];
  llmType?: string;
}

/** predict（POST /predict）入力。model 省略時は既定モデル。temperature は任意（構造化出力用の低温指定）。 */
export interface PredictRequest {
  model?: Model;
  messages: UnrecordedMessage[];
  id: string;
  temperature?: number;
}

/** predictTitle（POST /predict/title）入力。生成したタイトルを当該 chat へ書き戻す。 */
export interface PredictTitleRequest {
  model?: Model;
  chat: { id?: string; chatId: string; createdDate: string };
  prompt: string;
  id: string;
}

/** ストリーミング応答チャンク（predictStream の JSONL 1 行＝JSON.stringify(StreamingChunk)+'\n'）。 */
export interface StreamingChunk {
  text: string;
  trace?: string;
  stopReason?: string;
  sessionId?: string;
}

/** generateImage（POST /image/generate）入力。params は画像生成バックエンドへ素通しするため広めの型。 */
export interface GenerateImageRequest {
  model?: Model;
  params: Record<string, unknown>;
}

/** startTranscription（POST /transcribe/start）入力。audioKey は所有権プレフィックス付きストレージキー。 */
export interface StartTranscriptionRequest {
  audioKey: string;
  speakerLabel: boolean;
  maxSpeakers: number;
}

/** 文字起こし 1 セグメント（話者ラベル＋本文）。 */
export interface Transcript {
  speakerLabel?: string;
  transcript: string;
}

/** getTranscription（GET /transcribe/result/{jobName}）応答。COMPLETED 以外は transcripts 省略。 */
export interface GetTranscriptionResponse {
  status: string;
  languageCode?: string;
  transcripts?: Transcript[];
}

/** 横断アプリ登録一覧（listExApps #40）の要素＝ExApp にチーム名を付与したもの。 */
export type ListExAppsResponse = Array<ExApp & { teamName: string }>;

/** ExApp 呼び出しステータス（フロント契約・大文字。内部 DB の running/success/error を境界で写像）。 */
export type ExAppInvokeStatus = 'ACCEPTED' | 'IN_PROGRESS' | 'COMPLETED' | 'ERROR';

/** 退避済み artifact の参照（s3Url は getArtifactFile が所有権検証して署名 URL 化）。 */
export interface ExAppArtifactRef {
  displayName: string;
  s3Url: string;
}

/** 呼び出し履歴（listInvokeExAppHistories #42 / getInvokeExAppHistory #43）。 */
export interface InvokeExAppHistory {
  teamId: string;
  teamName: string;
  exAppId: string;
  exAppName: string;
  userId: string;
  inputs: Record<string, unknown>;
  outputs: string;
  createdDate: string;
  status: ExAppInvokeStatus;
  progress: string;
  sessionId?: string;
  /** ファイル形式の出力（退避済み・getArtifactFile に s3Url を渡してダウンロード）。無い場合は省略。 */
  artifacts?: ExAppArtifactRef[];
}

export interface ListInvokeExAppHistoriesResponse {
  history: InvokeExAppHistory[];
  lastEvaluatedKey: string | null;
}

export interface GetInvokeExAppHistoryResponse {
  history: InvokeExAppHistory | null;
}

export interface Team {
  teamId: string;
  teamName: string;
  createdDate: string;
  updatedDate: string;
}

export interface TeamUser {
  teamId: string;
  userId: string;
  username: string;
  isAdmin: boolean;
  createdDate: string;
  updatedDate: string;
}

export type ExAppStatus = 'draft' | 'published';

export interface ExApp {
  teamId: string;
  exAppId: string;
  exAppName: string;
  endpoint: string;
  /** 任意の設定文字列（既定 ''）。Prisma config(Json) ペイロード内の同名サブ項目。 */
  config?: string;
  placeholder: string;
  systemPrompt?: string;
  systemPromptKeyName?: string;
  description: string;
  howToUse: string;
  /** 呼び出し用シークレットは応答で常に空文字（SecretStore seam・秘匿）。 */
  apiKey: string;
  copyable?: boolean;
  status?: ExAppStatus;
  createdDate: string;
  updatedDate: string;
}
