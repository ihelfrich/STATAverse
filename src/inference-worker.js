import {
  inferenceParameters,
  inferenceSample,
  compactSample,
  summarizeSimulation,
} from "./labs/inference-model.js";

self.onmessage = ({ data }) => {
  try {
    const parameters = inferenceParameters(data.parameters),
      records = [];
    for (let i = 0; i < parameters.repetitions; i++) {
      records.push(compactSample(inferenceSample(parameters, i)));
      if ((i + 1) % 25 === 0 || i + 1 === parameters.repetitions)
        self.postMessage({
          kind: "progress",
          completed: i + 1,
          total: parameters.repetitions,
        });
    }
    self.postMessage({
      kind: "complete",
      records,
      summary: summarizeSimulation(records, parameters),
    });
  } catch (error) {
    self.postMessage({ kind: "error", message: error.message });
  }
};
