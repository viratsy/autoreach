"use client";

interface Props {
  steps: string[];
  currentStep: number;
}

export default function StepIndicator({ steps, currentStep }: Props) {
  return (
    <div className="flex items-center gap-2">
      {steps.map((label, index) => (
        <div key={label} className="flex items-center">
          <div className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                index <= currentStep
                  ? "bg-primary-600 text-white"
                  : "bg-gray-200 text-gray-500"
              }`}
            >
              {index + 1}
            </div>
            <span
              className={`text-sm hidden md:inline ${
                index <= currentStep ? "text-gray-900 font-medium" : "text-gray-400"
              }`}
            >
              {label}
            </span>
          </div>
          {index < steps.length - 1 && (
            <div className={`w-8 h-0.5 mx-2 ${index < currentStep ? "bg-primary-600" : "bg-gray-200"}`} />
          )}
        </div>
      ))}
    </div>
  );
}
