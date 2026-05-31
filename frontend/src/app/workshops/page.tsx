"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/layout/Sidebar";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { Download, Users, CheckCircle, XCircle, Clock } from "lucide-react";

interface WorkshopStat {
  workshopName: string;
  wsCode: string;
  total: number;
  active: number;
  converted: number;
  completed: number;
  avgCounter: number;
}

interface Contact {
  name: string;
  phone: string;
  email: string;
  workshopName: string;
  wsCode: string;
  counter: number;
  status: string;
  lastBatchDate: string;
  registeredAt: string;
}

const statusColors: Record<string, string> = {
  waiting: "bg-gray-100 text-gray-700",
  active: "bg-blue-100 text-blue-700",
  converted: "bg-green-100 text-green-700",
  completed: "bg-purple-100 text-purple-700",
};

export default function WorkshopsPage() {
  const [stats, setStats] = useState<WorkshopStat[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedWs, setSelectedWs] = useState<string>("");
  const [selectedStatus, setSelectedStatus] = useState<string>("active");
  const [loading, setLoading] = useState(true);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [totalContacts, setTotalContacts] = useState(0);

  useEffect(() => {
    loadStats();
  }, []);

  useEffect(() => {
    loadContacts();
  }, [selectedWs, selectedStatus]);

  const loadStats = async () => {
    try {
      const data = await apiRequest<{ stats: WorkshopStat[]; totalContacts: number }>("/workshops/stats");
      setStats(data.stats);
      setTotalContacts(data.totalContacts);
      if (data.stats.length > 0 && !selectedWs) {
        setSelectedWs(data.stats[0].wsCode);
      }
    } catch {} finally { setLoading(false); }
  };

  const loadContacts = async () => {
    if (!selectedWs) return;
    setLoadingContacts(true);
    try {
      const params = new URLSearchParams({ wsCode: selectedWs, status: selectedStatus });
      const data = await apiRequest<{ contacts: Contact[]; total: number }>(`/workshops/contacts?${params}`);
      setContacts(data.contacts);
    } catch {} finally { setLoadingContacts(false); }
  };

  const handleDownload = () => {
    const params = new URLSearchParams();
    if (selectedWs) params.set("wsCode", selectedWs);
    if (selectedStatus) params.set("status", selectedStatus);
    const url = `${process.env.NEXT_PUBLIC_API_URL}/workshops/download?${params}`;
    window.open(url, "_blank");
  };

  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-6xl">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">Workshop Re-engagement</h2>

            {/* Stats Cards */}
            {loading ? (
              <p className="text-gray-400 text-sm">Loading...</p>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                  <div className="bg-white rounded-lg border border-gray-200 p-4">
                    <Users className="w-5 h-5 text-gray-500 mb-1" />
                    <p className="text-2xl font-bold text-gray-900">{totalContacts}</p>
                    <p className="text-xs text-gray-500">Total Contacts</p>
                  </div>
                  <div className="bg-white rounded-lg border border-gray-200 p-4">
                    <Clock className="w-5 h-5 text-blue-500 mb-1" />
                    <p className="text-2xl font-bold text-gray-900">{stats.reduce((s, w) => s + w.active, 0)}</p>
                    <p className="text-xs text-gray-500">Active in Funnel</p>
                  </div>
                  <div className="bg-white rounded-lg border border-gray-200 p-4">
                    <CheckCircle className="w-5 h-5 text-green-500 mb-1" />
                    <p className="text-2xl font-bold text-gray-900">{stats.reduce((s, w) => s + w.converted, 0)}</p>
                    <p className="text-xs text-gray-500">Converted (Paid)</p>
                  </div>
                  <div className="bg-white rounded-lg border border-gray-200 p-4">
                    <XCircle className="w-5 h-5 text-purple-500 mb-1" />
                    <p className="text-2xl font-bold text-gray-900">{stats.reduce((s, w) => s + w.completed, 0)}</p>
                    <p className="text-xs text-gray-500">Completed (4 batches)</p>
                  </div>
                </div>

                {/* Per-workshop stats */}
                {stats.length > 0 && (
                  <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
                    <h3 className="font-semibold text-gray-900 mb-3">By Workshop</h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-600">
                          <tr>
                            <th className="text-left px-4 py-2 font-medium">Workshop</th>
                            <th className="text-left px-4 py-2 font-medium">Total</th>
                            <th className="text-left px-4 py-2 font-medium">Active</th>
                            <th className="text-left px-4 py-2 font-medium">Converted</th>
                            <th className="text-left px-4 py-2 font-medium">Completed</th>
                            <th className="text-left px-4 py-2 font-medium">Avg Batches</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {stats.map((ws) => (
                            <tr key={ws.wsCode} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelectedWs(ws.wsCode)}>
                              <td className="px-4 py-2 font-medium text-gray-900">{ws.workshopName}</td>
                              <td className="px-4 py-2 text-gray-600">{ws.total}</td>
                              <td className="px-4 py-2 text-blue-600 font-medium">{ws.active}</td>
                              <td className="px-4 py-2 text-green-600 font-medium">{ws.converted}</td>
                              <td className="px-4 py-2 text-purple-600">{ws.completed}</td>
                              <td className="px-4 py-2 text-gray-500">{ws.avgCounter}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Contacts Table */}
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <select
                        value={selectedWs}
                        onChange={(e) => setSelectedWs(e.target.value)}
                        className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
                      >
                        {stats.map((ws) => (
                          <option key={ws.wsCode} value={ws.wsCode}>{ws.workshopName}</option>
                        ))}
                      </select>
                      <div className="flex gap-1">
                        {["waiting", "active", "converted", "completed"].map((s) => (
                          <button
                            key={s}
                            onClick={() => setSelectedStatus(s)}
                            className={`px-2 py-1 rounded text-xs font-medium capitalize ${
                              selectedStatus === s ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                    <button
                      onClick={handleDownload}
                      className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium"
                    >
                      <Download className="w-3 h-3" />
                      Download CSV
                    </button>
                  </div>

                  {loadingContacts ? (
                    <p className="p-5 text-gray-400 text-sm">Loading...</p>
                  ) : contacts.length === 0 ? (
                    <p className="p-5 text-gray-400 text-sm">No contacts found</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-600">
                          <tr>
                            <th className="text-left px-5 py-2 font-medium">Name</th>
                            <th className="text-left px-5 py-2 font-medium">Phone</th>
                            <th className="text-left px-5 py-2 font-medium">Email</th>
                            <th className="text-left px-5 py-2 font-medium">Counter</th>
                            <th className="text-left px-5 py-2 font-medium">Status</th>
                            <th className="text-left px-5 py-2 font-medium">Last Batch</th>
                            <th className="text-left px-5 py-2 font-medium">Registered</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {contacts.map((c, i) => (
                            <tr key={i} className="hover:bg-gray-50">
                              <td className="px-5 py-2 text-gray-900">{c.name}</td>
                              <td className="px-5 py-2 text-gray-600">{c.phone}</td>
                              <td className="px-5 py-2 text-gray-500 text-xs">{c.email}</td>
                              <td className="px-5 py-2 text-gray-900 font-medium">{c.counter}/4</td>
                              <td className="px-5 py-2">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[c.status]}`}>
                                  {c.status}
                                </span>
                              </td>
                              <td className="px-5 py-2 text-gray-500">{c.lastBatchDate || "-"}</td>
                              <td className="px-5 py-2 text-gray-500 text-xs">{c.registeredAt ? new Date(c.registeredAt).toLocaleDateString() : "-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
