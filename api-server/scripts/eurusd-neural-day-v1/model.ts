export type Architecture = {
  name: string;
  hidden1: number;
  hidden2: number;
};

export type Sample = { x: number[]; y: 0 | 1 };

export type NeuralModel = {
  architecture: Architecture;
  mean: number[];
  std: number[];
  w1: number[];
  b1: number[];
  w2: number[];
  b2: number[];
  w3: number[];
  b3: number;
};

class Random {
  constructor(private state: number) {}
  next() {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let value = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }
  normal() {
    const a = Math.max(this.next(), 1e-12);
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * this.next());
  }
}

function sigmoid(value: number) {
  const clipped = Math.max(-30, Math.min(30, value));
  return 1 / (1 + Math.exp(-clipped));
}

function standardizer(samples: Sample[]) {
  const width = samples[0]?.x.length ?? 0;
  const mean = new Array<number>(width).fill(0);
  const std = new Array<number>(width).fill(0);
  for (const sample of samples) for (let i = 0; i < width; i += 1) mean[i]! += sample.x[i]!;
  for (let i = 0; i < width; i += 1) mean[i]! /= Math.max(1, samples.length);
  for (const sample of samples) {
    for (let i = 0; i < width; i += 1) std[i]! += (sample.x[i]! - mean[i]!) ** 2;
  }
  for (let i = 0; i < width; i += 1) std[i] = Math.sqrt(std[i]! / Math.max(1, samples.length)) || 1;
  return { mean, std };
}

function scaled(x: number[], mean: number[], std: number[]) {
  return x.map((value, index) => (value - mean[index]!) / std[index]!);
}

type Params = {
  w1: Float64Array; b1: Float64Array;
  w2: Float64Array; b2: Float64Array;
  w3: Float64Array; b3: Float64Array;
};

function allocate(width: number, architecture: Architecture, random: Random): Params {
  const h1 = architecture.hidden1;
  const h2 = architecture.hidden2;
  if (h1 === 0) {
    return {
      w1: new Float64Array(0), b1: new Float64Array(0),
      w2: new Float64Array(0), b2: new Float64Array(0),
      w3: Float64Array.from({ length: width }, () => random.normal() * Math.sqrt(1 / width)),
      b3: new Float64Array(1),
    };
  }
  const w1 = Float64Array.from({ length: width * h1 }, () => random.normal() * Math.sqrt(2 / width));
  if (h2 === 0) {
    return {
      w1, b1: new Float64Array(h1),
      w2: new Float64Array(0), b2: new Float64Array(0),
      w3: Float64Array.from({ length: h1 }, () => random.normal() * Math.sqrt(1 / h1)),
      b3: new Float64Array(1),
    };
  }
  return {
    w1, b1: new Float64Array(h1),
    w2: Float64Array.from({ length: h1 * h2 }, () => random.normal() * Math.sqrt(2 / h1)),
    b2: new Float64Array(h2),
    w3: Float64Array.from({ length: h2 }, () => random.normal() * Math.sqrt(1 / h2)),
    b3: new Float64Array(1),
  };
}

function forward(x: number[], p: Params, architecture: Architecture) {
  const h1 = architecture.hidden1;
  const h2 = architecture.hidden2;
  if (h1 === 0) {
    let z = p.b3[0]!;
    for (let i = 0; i < x.length; i += 1) z += p.w3[i]! * x[i]!;
    return { a1: new Float64Array(0), a2: new Float64Array(0), probability: sigmoid(z) };
  }
  const a1 = new Float64Array(h1);
  for (let j = 0; j < h1; j += 1) {
    let z = p.b1[j]!;
    for (let i = 0; i < x.length; i += 1) z += p.w1[j * x.length + i]! * x[i]!;
    a1[j] = Math.tanh(z);
  }
  if (h2 === 0) {
    let z = p.b3[0]!;
    for (let j = 0; j < h1; j += 1) z += p.w3[j]! * a1[j]!;
    return { a1, a2: new Float64Array(0), probability: sigmoid(z) };
  }
  const a2 = new Float64Array(h2);
  for (let k = 0; k < h2; k += 1) {
    let z = p.b2[k]!;
    for (let j = 0; j < h1; j += 1) z += p.w2[k * h1 + j]! * a1[j]!;
    a2[k] = Math.tanh(z);
  }
  let z = p.b3[0]!;
  for (let k = 0; k < h2; k += 1) z += p.w3[k]! * a2[k]!;
  return { a1, a2, probability: sigmoid(z) };
}

export function trainNeuralModel(
  samples: Sample[],
  architecture: Architecture,
  options: { seed: number; epochs: number; learningRate: number; l2: number; classBalance?: boolean },
): NeuralModel {
  if (!samples.length) throw new Error("Cannot train without samples.");
  const { mean, std } = standardizer(samples);
  const xs = samples.map((sample) => scaled(sample.x, mean, std));
  const positives = samples.reduce((sum, sample) => sum + sample.y, 0);
  const positiveWeight = options.classBalance === false ? 1 : samples.length / Math.max(1, 2 * positives);
  const negativeWeight = options.classBalance === false ? 1 : samples.length / Math.max(1, 2 * (samples.length - positives));
  const random = new Random(options.seed);
  const params = allocate(xs[0]!.length, architecture, random);
  const all = [params.w1, params.b1, params.w2, params.b2, params.w3, params.b3];
  const firstMoment = all.map((array) => new Float64Array(array.length));
  const secondMoment = all.map((array) => new Float64Array(array.length));
  const order = samples.map((_, index) => index);
  let step = 0;

  const update = (parameter: Float64Array, gradient: Float64Array, m: Float64Array, v: Float64Array) => {
    const b1Correction = 1 - 0.9 ** step;
    const b2Correction = 1 - 0.999 ** step;
    for (let i = 0; i < parameter.length; i += 1) {
      const g = gradient[i]!;
      m[i] = 0.9 * m[i]! + 0.1 * g;
      v[i] = 0.999 * v[i]! + 0.001 * g * g;
      parameter[i] -= options.learningRate * (m[i]! / b1Correction) / (Math.sqrt(v[i]! / b2Correction) + 1e-8);
    }
  };

  const batchSize = 256;
  for (let epoch = 0; epoch < options.epochs; epoch += 1) {
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random.next() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (let start = 0; start < order.length; start += batchSize) {
      const end = Math.min(order.length, start + batchSize);
      const gradients = all.map((array) => new Float64Array(array.length));
      for (let position = start; position < end; position += 1) {
        const row = order[position]!;
        const x = xs[row]!;
        const y = samples[row]!.y;
        const f = forward(x, params, architecture);
        const classWeight = y ? positiveWeight : negativeWeight;
        const delta3 = (f.probability - y) * classWeight;
        const h1 = architecture.hidden1;
        const h2 = architecture.hidden2;
        if (h1 === 0) {
          for (let i = 0; i < x.length; i += 1) gradients[4]![i] += delta3 * x[i]!;
          gradients[5]![0] += delta3;
          continue;
        }
        if (h2 === 0) {
          for (let j = 0; j < h1; j += 1) gradients[4]![j] += delta3 * f.a1[j]!;
          gradients[5]![0] += delta3;
          for (let j = 0; j < h1; j += 1) {
            const delta1 = delta3 * params.w3[j]! * (1 - f.a1[j]! ** 2);
            gradients[1]![j] += delta1;
            for (let i = 0; i < x.length; i += 1) gradients[0]![j * x.length + i] += delta1 * x[i]!;
          }
          continue;
        }
        for (let k = 0; k < h2; k += 1) gradients[4]![k] += delta3 * f.a2[k]!;
        gradients[5]![0] += delta3;
        for (let k = 0; k < h2; k += 1) {
          const delta2 = delta3 * params.w3[k]! * (1 - f.a2[k]! ** 2);
          gradients[3]![k] += delta2;
          for (let j = 0; j < h1; j += 1) gradients[2]![k * h1 + j] += delta2 * f.a1[j]!;
        }
        for (let j = 0; j < h1; j += 1) {
          let upstream = 0;
          for (let k = 0; k < h2; k += 1) upstream += (delta3 * params.w3[k]! * (1 - f.a2[k]! ** 2)) * params.w2[k * h1 + j]!;
          const delta1 = upstream * (1 - f.a1[j]! ** 2);
          gradients[1]![j] += delta1;
          for (let i = 0; i < x.length; i += 1) gradients[0]![j * x.length + i] += delta1 * x[i]!;
        }
      }
      const scale = 1 / Math.max(1, end - start);
      step += 1;
      for (let group = 0; group < gradients.length; group += 1) {
        const gradient = gradients[group]!;
        const parameter = all[group]!;
        for (let i = 0; i < gradient.length; i += 1) {
          gradient[i] = gradient[i]! * scale + (group === 0 || group === 2 || group === 4 ? options.l2 * parameter[i]! : 0);
        }
        update(parameter, gradient, firstMoment[group]!, secondMoment[group]!);
      }
    }
  }

  return {
    architecture,
    mean,
    std,
    w1: [...params.w1], b1: [...params.b1],
    w2: [...params.w2], b2: [...params.b2],
    w3: [...params.w3], b3: params.b3[0]!,
  };
}

export function predict(model: NeuralModel, raw: number[]) {
  const x = scaled(raw, model.mean, model.std);
  const h1 = model.architecture.hidden1;
  const h2 = model.architecture.hidden2;
  if (h1 === 0) {
    let z = model.b3;
    for (let i = 0; i < x.length; i += 1) z += model.w3[i]! * x[i]!;
    return sigmoid(z);
  }
  const a1 = new Array<number>(h1).fill(0);
  for (let j = 0; j < h1; j += 1) {
    let z = model.b1[j]!;
    for (let i = 0; i < x.length; i += 1) z += model.w1[j * x.length + i]! * x[i]!;
    a1[j] = Math.tanh(z);
  }
  if (h2 === 0) {
    let z = model.b3;
    for (let j = 0; j < h1; j += 1) z += model.w3[j]! * a1[j]!;
    return sigmoid(z);
  }
  const a2 = new Array<number>(h2).fill(0);
  for (let k = 0; k < h2; k += 1) {
    let z = model.b2[k]!;
    for (let j = 0; j < h1; j += 1) z += model.w2[k * h1 + j]! * a1[j]!;
    a2[k] = Math.tanh(z);
  }
  let z = model.b3;
  for (let k = 0; k < h2; k += 1) z += model.w3[k]! * a2[k]!;
  return sigmoid(z);
}
