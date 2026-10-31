"use client";

interface Props {
  steps: string[];
  currentStep: number;
  // Highest step index reached so far — clicking is only allowed up to here.
  // Jumping ahead into a step that depends on data from a step never
  // visited (e.g. Map Parameters before a template exists) would just
  // render broken/empty, so only backward/lateral navigation is offered.
  maxStepReached: number;
  onStepClick: (index: number) => void;
}

export default function StepIndicator({ steps, currentStep, maxStepReached, onStepClick }: Props) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {steps.map((label, index) => {
        const clickable = index <= maxStepReached && index !== currentStep;
        return (
          <div key={label} className="flex items-center">
            <button
              type="button"
              onClick={() => clickable && onStepClick(index)}
              disabled={!clickable}
              title={clickable ? `Go to ${label}` : undefined}
              className={`flex items-center gap-2 rounded-full ${clickable ? "cursor-pointer" : "cursor-default"}`}
            >
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                  index <= currentStep
                    ? "bg-primary-600 text-white"
                    : "bg-gray-200 text-gray-500"
                } ${clickable ? "hover:ring-2 hover:ring-primary-300" : ""}`}
              >
                {index + 1}
              </div>
              <span
                className={`text-sm hidden md:inline ${
                  index <= currentStep ? "text-gray-900 font-medium" : "text-gray-400"
                } ${clickable ? "hover:text-primary-700" : ""}`}
              >
                {label}
              </span>
            </button>
            {index < steps.length - 1 && (
              <div className={`w-8 h-0.5 mx-2 ${index < currentStep ? "bg-primary-600" : "bg-gray-200"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
