import { type IHostSettings, type IImageMetadata } from '@/utils/types';

export interface InferenceTask {
  id: string;
  imageSrc: string;
  hostname: string;
  priority: number;
  createdAt: Date;
  tabId: number;
  hostSettings: IHostSettings;
  imageMetadata?: IImageMetadata;
}
