/**
 * ストレージのバケット設定（上流の BUCKET_NAME / AUDIO_BUCKET_NAME / ARTIFACTS_BUCKET_NAME 相当）。
 * 実 SeaweedFS バケット名は env で配線する（後続）。未設定時は handler が上流同様 500 を返す。
 */
export interface StorageBuckets {
  /** 汎用ファイル（file 群 #15-17）。 */
  fileBucket?: string;
  /** 音声（transcribe アップロード #19・文字起こし入力）。 */
  audioBucket?: string;
  /** ExApp アーティファクト（getArtifactFile #44）。 */
  artifactsBucket?: string;
}

export function loadStorageBuckets(): StorageBuckets {
  return {
    fileBucket: process.env.FILE_BUCKET_NAME,
    audioBucket: process.env.AUDIO_BUCKET_NAME,
    artifactsBucket: process.env.ARTIFACTS_BUCKET_NAME,
  };
}
