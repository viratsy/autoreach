"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import BusinessForm from "@/components/business/BusinessForm";
import AddNumberToBusiness from "@/components/business/AddNumberToBusiness";
import { apiRequest } from "@/lib/api";
import { Business } from "@/types";

function BusinessFormPage() {
  const searchParams = useSearchParams();
  const businessId = searchParams.get("businessId");
  const isEdit = Boolean(businessId);

  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"new" | "existing">("new");

  useEffect(() => {
    apiRequest<{ businesses: Business[] }>("/businesses")
      .then((data) => setBusinesses(data.businesses))
      .finally(() => setLoading(false));
  }, []);

  const editingBusiness = businesses.find((b) => b.businessId === businessId);

  return (
    <AuthGuard>
      <AppShell>
          <h2 className="text-2xl font-bold text-gray-900 mb-6">
            {isEdit ? "Edit Business" : "Add Business"}
          </h2>

          {!isEdit && (
            <div className="flex gap-2 mb-6">
              <button
                onClick={() => setMode("new")}
                className={`text-sm px-4 py-2 rounded-lg font-medium ${
                  mode === "new" ? "bg-primary-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                Create New Business
              </button>
              <button
                onClick={() => setMode("existing")}
                className={`text-sm px-4 py-2 rounded-lg font-medium ${
                  mode === "existing" ? "bg-primary-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                Add Number to Existing Business
              </button>
            </div>
          )}

          {loading ? (
            <div className="text-center py-12 text-gray-500">Loading...</div>
          ) : isEdit ? (
            <BusinessForm business={editingBusiness} />
          ) : mode === "existing" ? (
            <AddNumberToBusiness businesses={businesses} />
          ) : (
            <BusinessForm />
          )}
      </AppShell>
    </AuthGuard>
  );
}

export default function NewBusinessPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-gray-400 text-sm">Loading...</div>}>
      <BusinessFormPage />
    </Suspense>
  );
}
