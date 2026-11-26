'use client';

import { useState, useEffect, useCallback } from 'react';
import { FileText, Upload, CheckCircle2, XCircle, Trash2, ExternalLink, X, ShieldCheck } from 'lucide-react';
import { DRIVER_DOC_TYPES } from '@/lib/driver-doc-types';

interface DriverDoc {
  id: number;
  driver_id: number;
  vehicle_id: number | null;
  vehicle_reg: string | null;
  doc_type: string;
  doc_number: string | null;
  expiry_date: string | null;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  verification_status: 'PENDING' | 'VERIFIED' | 'REJECTED';
  verified_at: string | null;
  verified_by_name: string | null;
  uploaded_by_name: string | null;
  rejection_reason: string | null;
  created_at: string;
  file_url: string;
}

interface DriverDocumentsDialogProps {
  driver: {
    id: number;
    full_name: string;
    phone: string;
    vehicles?: Array<{ id: number; registration_no: string; model_name: string }>;
  };
  canManage: boolean;
  onClose: () => void;
}

const DOC_LABEL_MAP: Record<string, string> = Object.fromEntries(
  DRIVER_DOC_TYPES.map((d) => [d.code, d.label])
);

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function DriverDocumentsDialog({ driver, canManage, onClose }: DriverDocumentsDialogProps) {
  const [docs, setDocs] = useState<DriverDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [docType, setDocType] = useState<string>('AADHAAR_FRONT');
  const [vehicleId, setVehicleId] = useState<string>('');
  const [docNumber, setDocNumber] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyDocId, setBusyDocId] = useState<number | null>(null);

  const loadDocs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/drivers/${driver.id}/documents`, { cache: 'no-store' });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not load documents');
      } else {
        setDocs(data.documents || []);
      }
    } catch {
      setError('Network error while loading driver documents');
    } finally {
      setLoading(false);
    }
  }, [driver.id]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedFile) {
      setError('Please choose a JPG, PNG, WebP, or PDF file.');
      return;
    }
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const fd = new FormData();
      fd.append('file', selectedFile);
      fd.append('doc_type', docType);
      if (vehicleId) fd.append('vehicle_id', vehicleId);
      if (docNumber.trim()) fd.append('doc_number', docNumber.trim());
      if (expiryDate) fd.append('expiry_date', expiryDate);

      const res = await fetch(`/api/drivers/${driver.id}/documents`, {
        method: 'POST',
        body: fd,
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Upload failed');
      } else {
        setNotice(`Uploaded ${DOC_LABEL_MAP[docType] || docType}.`);
        setDocNumber('');
        setExpiryDate('');
        setSelectedFile(null);
        const inputEl = document.getElementById('driver-kyc-file-input') as HTMLInputElement | null;
        if (inputEl) inputEl.value = '';
        await loadDocs();
      }
    } catch {
      setError('Network error while uploading document');
    } finally {
      setUploading(false);
    }
  }

  async function updateVerification(doc: DriverDoc, status: 'VERIFIED' | 'REJECTED') {
    let reason: string | undefined;
    if (status === 'REJECTED') {
      const prompted = window.prompt('Reason for rejecting this document:', doc.rejection_reason || 'Document unclear / expired');
      if (prompted === null) return;
      reason = prompted;
    }
    setBusyDocId(doc.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/drivers/${driver.id}/documents/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verification_status: status, rejection_reason: reason }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not update document status');
      } else {
        setNotice(`Marked ${DOC_LABEL_MAP[doc.doc_type] || doc.doc_type} as ${status}.`);
        await loadDocs();
      }
    } finally {
      setBusyDocId(null);
    }
  }

  async function deleteDoc(doc: DriverDoc) {
    if (!window.confirm(`Delete ${DOC_LABEL_MAP[doc.doc_type] || doc.doc_type} (${doc.original_filename})?`)) return;
    setBusyDocId(doc.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/drivers/${driver.id}/documents/${doc.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Delete failed');
      } else {
        setNotice('Document deleted.');
        await loadDocs();
      }
    } finally {
      setBusyDocId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-orange-600" /> KYC &amp; Vehicle Documents — {driver.full_name}
            </h2>
            <p className="text-xs text-slate-600 font-mono">{driver.phone} &bull; Private authenticated storage (never public)</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 text-slate-600 hover:text-slate-900">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-5 flex-1">
          {notice && <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold">{notice}</div>}
          {error && <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold">{error}</div>}

          {canManage && (
            <form onSubmit={handleUpload} className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                <Upload className="h-4 w-4 text-orange-600" /> Upload Document (Aadhaar, PAN, DL, RC, Insurance, Permit, PUC)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">Document Type *</label>
                  <select
                    value={docType}
                    onChange={(e) => setDocType(e.target.value)}
                    className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white text-slate-900"
                  >
                    {DRIVER_DOC_TYPES.map((t) => (
                      <option key={t.code} value={t.code}>{t.label}</option>
                    ))}
                  </select>
                </div>
                {driver.vehicles && driver.vehicles.length > 0 && (
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700">Vehicle (optional)</label>
                    <select
                      value={vehicleId}
                      onChange={(e) => setVehicleId(e.target.value)}
                      className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white text-slate-900"
                    >
                      <option value="">Driver-level doc</option>
                      {driver.vehicles.map((v) => (
                        <option key={v.id} value={String(v.id)}>{v.registration_no} ({v.model_name})</option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">Document Number (optional)</label>
                  <input
                    value={docNumber}
                    onChange={(e) => setDocNumber(e.target.value)}
                    placeholder="e.g. BR01-202100..."
                    className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs font-mono text-slate-900 bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">Expiry Date (optional)</label>
                  <input
                    type="date"
                    value={expiryDate}
                    onChange={(e) => setExpiryDate(e.target.value)}
                    className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs text-slate-900 bg-white"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <input
                  id="driver-kyc-file-input"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                  className="text-xs text-slate-700 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-slate-300 file:text-xs file:font-semibold file:bg-white file:text-slate-700 hover:file:bg-slate-100"
                />
                <button
                  type="submit"
                  disabled={uploading || !selectedFile}
                  className="inline-flex items-center px-4 py-1.5 rounded-lg text-xs font-semibold bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50"
                >
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                  {uploading ? 'Uploading...' : 'Upload Document'}
                </button>
              </div>
              <p className="text-[11px] text-slate-600">Accepted: JPG, PNG, WebP, PDF (max 5 MB).</p>
            </form>
          )}

          {/* Uploaded Documents List */}
          <div className="space-y-2.5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
              Uploaded Documents ({docs.length})
            </h3>
            {loading ? (
              <div className="text-xs text-slate-600 py-6 text-center">Loading documents...</div>
            ) : docs.length === 0 ? (
              <div className="text-xs text-slate-600 py-8 text-center bg-slate-50 rounded-lg border border-dashed border-slate-300">
                No KYC or vehicle documents uploaded for this driver yet.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {docs.map((doc) => {
                  const isImage = doc.mime_type.startsWith('image/');
                  return (
                    <div key={doc.id} className="p-3.5 rounded-xl border border-slate-200 bg-white shadow-sm flex flex-col justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <a
                          href={doc.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-16 h-16 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-center overflow-hidden shrink-0 hover:ring-2 hover:ring-orange-500"
                          title="Open full document"
                        >
                          {isImage ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={doc.file_url} alt={doc.doc_type} className="w-full h-full object-cover" />
                          ) : (
                            <FileText className="h-7 w-7 text-rose-600" />
                          )}
                        </a>
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-bold text-xs text-slate-900 truncate">
                              {DOC_LABEL_MAP[doc.doc_type] || doc.doc_type}
                            </span>
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0 ${
                              doc.verification_status === 'VERIFIED'
                                ? 'bg-emerald-100 text-emerald-800'
                                : doc.verification_status === 'REJECTED'
                                  ? 'bg-rose-100 text-rose-800'
                                  : 'bg-amber-100 text-amber-900'
                            }`}>
                              {doc.verification_status}
                            </span>
                          </div>
                          {doc.doc_number && <div className="text-[11px] font-mono text-slate-800">No: {doc.doc_number}</div>}
                          {doc.vehicle_reg && <div className="text-[11px] font-mono text-slate-700">Vehicle: {doc.vehicle_reg}</div>}
                          {doc.expiry_date && <div className="text-[11px] font-mono text-slate-700">Expiry: {String(doc.expiry_date).slice(0, 10)}</div>}
                          <div className="text-[10px] text-slate-600 truncate">
                            {doc.original_filename} &bull; {fmtSize(doc.size_bytes)}
                          </div>
                          {doc.rejection_reason && (
                            <div className="text-[11px] text-rose-700 font-medium">Reason: {doc.rejection_reason}</div>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100">
                        <a
                          href={doc.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center text-xs font-semibold text-blue-700 hover:underline"
                        >
                          <ExternalLink className="h-3.5 w-3.5 mr-1" /> Open
                        </a>
                        {canManage && (
                          <div className="flex items-center gap-1.5">
                            {doc.verification_status !== 'VERIFIED' && (
                              <button
                                type="button"
                                disabled={busyDocId === doc.id}
                                onClick={() => updateVerification(doc, 'VERIFIED')}
                                className="inline-flex items-center px-2 py-1 text-[11px] font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                              >
                                <CheckCircle2 className="h-3 w-3 mr-1" /> Verify
                              </button>
                            )}
                            {doc.verification_status !== 'REJECTED' && (
                              <button
                                type="button"
                                disabled={busyDocId === doc.id}
                                onClick={() => updateVerification(doc, 'REJECTED')}
                                className="inline-flex items-center px-2 py-1 text-[11px] font-semibold rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                              >
                                <XCircle className="h-3 w-3 mr-1" /> Reject
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={busyDocId === doc.id}
                              onClick={() => deleteDoc(doc)}
                              className="p-1 text-rose-600 hover:bg-rose-50 rounded"
                              title="Delete document"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
