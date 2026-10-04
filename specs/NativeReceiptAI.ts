// TurboModule spec. Native side: on-device OCR (Core Vision Kit textRecognition) + optional MindSpore Lite
// line classifier. Returns raw lines; @gather/core parseReceipt() turns them into items and checks the totals.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type OcrLine = { text: string; confidence: number };

export interface Spec extends TurboModule {
  /** Reads text lines from an image file URI, top to bottom. Rejects on unreadable images. */
  recognize(imageUri: string): Promise<{ lines: OcrLine[] }>;
}

export default TurboModuleRegistry.get<Spec>('ReceiptAI');
