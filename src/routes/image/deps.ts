import type { ImageClient } from '../../lib/image/imageClient.js';

/** image Router の依存（注入式）。image は seam（実バックエンドは選定後に配線）。 */
export interface ImageDeps {
  image: ImageClient;
}
