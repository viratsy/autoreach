"use client";

import { useState } from "react";
import Sidebar from "@/components/layout/Sidebar";
import AuthGuard from "@/components/layout/AuthGuard";
import StepIndicator from "@/components/campaign/StepIndicator";
import SelectBusiness from "@/components/campaign/SelectBusiness";
import SelectNumbers from "@/components/campaign/SelectNumbers";
import UploadCSV from "@/components/campaign/UploadCSV";
import SelectTemplate from "@/components/campaign/SelectTemplate";
import MapParameters from "@/components/campaign/MapParameters";
import ReviewSchedule from "@/components/campaign/ReviewSchedule";
import { Business, PhoneNumber, Template } from "@/types";

const STEPS = [
  "Select Business",
  "Select Numbers",
  "Upload CSV",
  "Select Template",
  "Map Parameters",
  "Review & Schedule",
];

export interface CampaignDraft {
  business: Business | null;
  selectedNumbers: PhoneNumber[];
  csvFile: File | null;
  csvHeaders: string[];
  csvRowCount: number;
  template: Template | null;
  templateMappings: Record<string, string>;
  parameterMapping: Record<string, string>;
  campaignPrefix: string;
  scheduleDate: string;
  scheduleTime: string;
}

const initialDraft: CampaignDraft = {
  business: null,
  selectedNumbers: [],
  csvFile: null,
  csvHeaders: [],
  csvRowCount: 0,
  template: null,
  templateMappings: {},
  parameterMapping: {},
  campaignPrefix: "",
  scheduleDate: "",
  scheduleTime: "",
};

export default function NewCampaignPage() {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<CampaignDraft>(initialDraft);

  const updateDraft = (updates: Partial<CampaignDraft>) => {
    setDraft((prev) => ({ ...prev, ...updates }));
  };

  const renderStep = () => {
    switch (step) {
      case 0:
        return <SelectBusiness draft={draft} onUpdate={updateDraft} onNext={() => setStep(1)} />;
      case 1:
        return <SelectNumbers draft={draft} onUpdate={updateDraft} onNext={() => setStep(2)} onBack={() => setStep(0)} />;
      case 2:
        return <UploadCSV draft={draft} onUpdate={updateDraft} onNext={() => setStep(3)} onBack={() => setStep(1)} />;
      case 3:
        return <SelectTemplate draft={draft} onUpdate={updateDraft} onNext={() => setStep(4)} onBack={() => setStep(2)} />;
      case 4:
        return <MapParameters draft={draft} onUpdate={updateDraft} onNext={() => setStep(5)} onBack={() => setStep(3)} />;
      case 5:
        return <ReviewSchedule draft={draft} onUpdate={updateDraft} onBack={() => setStep(4)} />;
      default:
        return null;
    }
  };

  return (
    <AuthGuard>
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">Create Campaign</h2>
          <StepIndicator steps={STEPS} currentStep={step} />
          <div className="mt-8">{renderStep()}</div>
        </div>
      </main>
    </div>
    </AuthGuard>
  );
}
