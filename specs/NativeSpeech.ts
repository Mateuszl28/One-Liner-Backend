// TurboModule spec. Native side: Core Speech Kit (textToSpeech, speechRecognizer), offline engines.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  speak(text: string, language: string): Promise<void>;
  stopSpeaking(): void;
  /** Emits 'Speech.result' { text: string; final: boolean }. Feed final results to parseVoiceCommand(). */
  startListening(language: string): Promise<void>;
  stopListening(): void;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.get<Spec>('Speech');
