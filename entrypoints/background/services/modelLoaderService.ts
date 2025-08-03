import * as tf from '@tensorflow/tfjs';
import { load } from 'js-yaml';

import { logger } from '@/utils/logger';

import type { Metadata, YamlMetadata } from '@/utils/types';

export class ModelLoaderService {
  private readonly MODEL_PATH = '/models/afeef-11s-segment/model.json';
  private readonly METADATA_PATH = '/models/afeef-11s-segment/metadata.yaml';

  private model: tf.GraphModel | null = null;
  private config: Metadata = {
    // Values filled in after loading metadata
    names: [],
    stride: 32,
    imgsz: [640, 640],

    // Values that are fixed and do not change
    outputShape: [160, 160, 32],
    namesToCheck: ['person', 'zfa', 'zma'],
  };

  private async loadMetadata(): Promise<void> {
    const metadata = await fetch(this.METADATA_PATH)
      .then(response => response.text())
      .then(text => load(text))
      .then(yamlData => yamlData as YamlMetadata)
      .catch(error => {
        logger.error('Failed to load metadata:', error);
        return null;
      });

    if (metadata) {
      this.config = {
        ...this.config,
        names: metadata.names || this.config.names,
        stride: metadata.stride || this.config.stride,
        imgsz: metadata.imgsz || this.config.imgsz,
      };
    }
  }

  public async initialize(): Promise<void> {
    // Load the model
    try {
      await this.loadModelAsync();
      logger
        .withTag('modelLoaderService')
        .info('AI model loaded and ready for inference');
    } catch (error) {
      logger
        .withTag('modelLoaderService')
        .error('Failed to load AI model:', error);
      throw error;
    }

    // Load metadata from YAML file
    await this.loadMetadata();
    logger
      .withTag('modelLoaderService')
      .info(
        `Metadata loaded successfully: ${Object.keys(this.config.names).length} classes, stride: ${this.config.stride}, input shape: ${this.config.imgsz.join('x')}`,
      );
  }

  public async loadModelAsync(): Promise<tf.GraphModel> {
    if (this.model === null) {
      const loadedModel = await tf.loadGraphModel(this.MODEL_PATH);

      if (!loadedModel) {
        throw new Error('Model not loaded');
      }

      this.model = loadedModel;
      await this.warmupModel(this.model);
    }
    return this.model;
  }

  public async warmupModel(model: tf.GraphModel): Promise<void> {
    try {
      const inputSpec = model.inputs?.[0];
      if (!inputSpec || !inputSpec.shape) {
        return;
      }

      const inputShape = inputSpec.shape;
      const actualShape = inputShape.map((dim: number | null) =>
        dim === -1 || dim === null ? 1 : dim,
      );
      const dummyInput = tf.randomUniform(actualShape, 0, 1, 'float32');

      // Suppress false warnings during warmup
      const originalWarn = console.warn;
      console.warn = () => {};

      const warmupResult = await model.executeAsync(dummyInput);
      console.warn = originalWarn;

      if (Array.isArray(warmupResult)) {
        warmupResult.forEach(tensor => tensor.dispose());
      } else {
        warmupResult.dispose();
      }

      dummyInput.dispose();
    } catch (error) {
      logger
        .withTag('modelLoaderService')
        .error('Error during model warmup:', error);
    }
  }

  public getModel(): tf.GraphModel | null {
    return this.model;
  }

  public isModelReady(): boolean {
    return this.model !== null;
  }

  public cleanup(): void {
    try {
      if (this.model) {
        this.model.dispose();
        this.model = null;
      }
    } catch (error) {
      logger
        .withTag('modelLoaderService')
        .error('Error during model cleanup:', error);
    }
  }

  public getModelConfig(): Metadata {
    return this.config;
  }
}
