'use client';

import React, { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { usePrescription } from '@/contexts/PrescriptionContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FormLabel } from '@/components/ui/form';
import { LanguageToggle } from '@/components/common/LanguageToggle';
import { MedicineForm } from '@/components/prescription/MedicalForm';
import { DataMultiSelect } from '@/components/prescription/DataMultiSelect';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DatePicker } from '@/components/ui/date-picker';
import Loading from '@/components/Loading';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Activity, ClipboardPlus, FlaskConical, User } from 'lucide-react';
// import { indexedDBManager, PrescriptionTemplate } from '@/lib/indexedDBManager';

const PrescriptionFormPage = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { formData, updateFormData, addTest, removeTest, updateTest, updateSelectedTests, t, resetForm } = usePrescription();
  const [isNavigating, setIsNavigating] = useState(false);
  const [showSuccessDialog, setShowSuccessDialog] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  // const [isSavingData, setIsSavingData] = useState(false);


  useEffect(() => {
    const status = searchParams.get('status');
    if (status === 'reset') {
      resetForm();
      router.replace('/');
    }
  }, [searchParams, resetForm, router]);

  const handlePatientChange = (field: keyof typeof formData.patient, value: string | string[]) => {
    updateFormData({
      patient: { ...formData.patient, [field]: value },
    });
  };

  const handleVitalChange = (field: keyof typeof formData.vitals, value: string) => {
    updateFormData({
      vitals: { ...formData.vitals, [field]: value },
    });
  };

  const handleDoctorSignatureChange = (field: keyof typeof formData.doctorSignature, value: string) => {
    updateFormData({
      doctorSignature: { ...formData.doctorSignature, [field]: value },
    });
  };

  const handleSignatureUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        handleDoctorSignatureChange('signature', result);
      };
      reader.readAsDataURL(file);
    }
  };

  const handlePreview = async () => {
    try {
      setIsNavigating(true);

      // Small delay to show loading state, then navigate
      setTimeout(() => {
        router.push('/preview');
      }, 200);
    } catch (error) {
      console.error('Error during preview:', error);
      setIsNavigating(false);
      setSuccessMessage('An error occurred. Please try again.');
      setShowSuccessDialog(true);
    }
  };

  return (
    <div className="min-h-screen p-4 sm:p-8 bg-[var(--background-color)]">
      <div className="max-w-7xl mx-auto">
        <div className="mb-10 flex justify-between items-center">
          <div>
            <h1 className="text-4xl font-bold text-gray-900 mb-2">Create New Prescription</h1>
            <p className="text-gray-600 text-lg">
              Fill in the details to generate a new prescription.
            </p>
          </div>
          <LanguageToggle />
        </div>

        <div className="space-y-8">
          {/* Patient Information */}
          <div className='space-y-8 md:space-y-0 md:grid md:grid-cols-2 md:gap-8'>
            {/* Patient Information Card */}
            <Card className=" bg-white">
              <CardHeader className="bg-gradient-to-r from-[var(--primary-color)]/5 to-[var(--primary-color)]/10 border-b border-gray-100">
                <CardTitle className="text-xl text-gray-900 flex items-center gap-3 font-semibold">
                  <div className="w-12 h-12 rounded-full bg-[var(--primary-color)]/10 flex items-center justify-center">
                    <User className="w-6 h-6 text-[var(--primary-color)]" />
                  </div>
                  {t('patient')} Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6 p-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div className="space-y-3 col-span-2">
                    <FormLabel htmlFor="patientName" className="text-sm font-semibold flex items-center gap-2">
                      {t('patientName')} <span className="text-red-500 text-base">*</span>
                    </FormLabel>
                    <div className="flex gap-3 items-center">
                      <Select
                        value={formData.patient.title}
                        onValueChange={(value) => handlePatientChange('title', value)}
                      >
                        <SelectTrigger className="h-11 w-[110px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="mr">{t('mr')}</SelectItem>
                          <SelectItem value="mrs">{t('mrs')}</SelectItem>
                          <SelectItem value="ms">{t('ms')}</SelectItem>
                          <SelectItem value="master">{t('master')}</SelectItem>
                          <SelectItem value="baby">{t('baby')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        id="patientName"
                        value={formData.patient.patientName}
                        onChange={(e) => handlePatientChange('patientName', e.target.value)}
                        placeholder="Enter full name"
                        className="h-11 border-gray-300 focus:border-green-500 transition-colors flex-1"
                      />
                    </div>
                  </div>

                  <div className='space-y-2 col-span-2 flex sm:flex-row sm:items-center justify-between sm:gap-4'>
                    <div className="">
                      <FormLabel htmlFor="gender" className="text-sm font-semibold">{t('gender')}</FormLabel>
                      <Select value={formData.patient.gender} onValueChange={(value) => handlePatientChange('gender', value)}>
                        <SelectTrigger className="h-11 border-gray-300 focus:border-green-500 transition-colors">
                          <SelectValue placeholder="Select gender" />
                        </SelectTrigger>
                        <SelectContent className="bg-white border border-gray-200 shadow-lg">
                          <SelectItem value="male" className="hover:bg-green-50 cursor-pointer">{t('male')}</SelectItem>
                          <SelectItem value="female" className="hover:bg-green-50 cursor-pointer">{t('female')}</SelectItem>
                          <SelectItem value="other" className="hover:bg-green-50 cursor-pointer">{t('other')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="">
                      <FormLabel htmlFor="age" className="text-sm font-semibold">{t('age')}</FormLabel>
                      <Input
                        id="age"
                        value={formData.patient.age}
                        onChange={(e) => handlePatientChange('age', e.target.value)}
                        placeholder="Years"
                        type="number"
                        min={0}
                        max={120}
                        className="h-11 border-gray-300 focus:border-green-500 transition-colors"
                      />
                    </div>
                    <div className="">
                      <FormLabel htmlFor="weight" className="text-sm font-semibold">{t('weight')}</FormLabel>
                      <div className="relative">
                        <Input
                          id="weight"
                          value={formData.patient.weight}
                          onChange={(e) => handlePatientChange('weight', e.target.value)}
                          placeholder="0.0"
                          type="number"
                          min={0}
                          max={1000}
                          step="0.1"
                          className="h-11 border-gray-300 focus:border-green-500 transition-colors pr-10"
                        />
                        <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500 text-sm">kg</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <FormLabel htmlFor="medicalHistory" className="text-sm font-semibold flex items-center gap-2">
                    Medical History
                  </FormLabel>
                  <DataMultiSelect
                    type="medicalHistory"
                    value={formData.patient.medicalHistory}
                    onChange={(value) => handlePatientChange('medicalHistory', value)}
                    placeholder="Select relevant medical history..."
                  />
                </div>
              </CardContent>
            </Card>

            {/* Vital Signs Card */}
            <Card className=" bg-white">
              <CardHeader className="bg-gradient-to-r from-blue-50 to-blue-100 border-b border-gray-100">
                <CardTitle className="text-xl text-gray-900 flex items-center gap-3 font-semibold">
                  <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center">
                    <Activity className="w-6 h-6 text-blue-600" />
                  </div>
                  Vital Signs
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <FormLabel htmlFor="bp" className="text-sm font-semibold flex items-center gap-2">
                      {t('bp')}
                      <span className="text-xs font-normal text-gray-500 bg-gray-100 px-2 py-1 rounded">(mmHg)</span>
                    </FormLabel>
                    <div className="relative">
                      <Input
                        id="bp"
                        value={formData.vitals.bp}
                        onChange={(e) => handleVitalChange('bp', e.target.value)}
                        placeholder="120/80"
                        type="text"
                        pattern="\d{1,3}/\d{1,3}"
                        title="Systolic/Diastolic (e.g. 120/80)"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <FormLabel htmlFor="pulse" className="text-sm font-semibold flex items-center gap-1">
                      {t('pulse')}
                      <span className="text-xs font-normal text-gray-500">(bpm)</span>
                    </FormLabel>
                    <div className="relative">
                      <Input
                        id="pulse"
                        value={formData.vitals.pulse}
                        onChange={(e) => handleVitalChange('pulse', e.target.value)}
                        placeholder="72"
                        type="number"
                        min={30}
                        max={200}
                        className="h-11 border-gray-300 focus:border-green-500 transition-colors pr-10"
                      />
                      <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500 text-sm">bpm</span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <FormLabel htmlFor="temp" className="text-sm font-semibold flex items-center gap-1">
                      {t('temperature')}
                      <span className="text-xs font-normal text-gray-500">(°F)</span>
                    </FormLabel>
                    <div className="relative">
                      <Input
                        id="temp"
                        value={formData.vitals.temp}
                        onChange={(e) => handleVitalChange('temp', e.target.value)}
                        placeholder="98.6"
                        type="number"
                        min={95}
                        max={110}
                        step="0.1"
                        className="h-11 border-gray-300 focus:border-green-500 transition-colors pr-10"
                      />
                      <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500 text-sm">°F</span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <FormLabel htmlFor="spo2" className="text-sm font-semibold flex items-center gap-1">
                      {t('spo2')}
                      <span className="text-xs font-normal text-gray-500">(%)</span>
                    </FormLabel>
                    <div className="relative">
                      <Input
                        id="spo2"
                        value={formData.vitals.spo2}
                        onChange={(e) => handleVitalChange('spo2', e.target.value)}
                        placeholder="98"
                        type="number"
                        min={70}
                        max={100}
                        className="h-11 border-gray-300 focus:border-green-500 transition-colors pr-10"
                      />
                      <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500 text-sm">%</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Diagnosis & Patient Complaints */}
          <Card className=" bg-white">
            <CardHeader className="bg-gradient-to-r from-purple-50 to-purple-100 border-b border-gray-100">
              <CardTitle className="text-xl text-gray-900 flex items-center gap-3 font-semibold">
                <div className="w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center">
                  <ClipboardPlus className='w-6 h-6 text-purple-600' />
                </div>
                Patient Complaints & Diagnosis
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-8 p-6">
              <div className="space-y-3">
                <FormLabel htmlFor="patientComplaints" className="text-sm font-semibold flex items-center gap-2">
                  {t('patientComplaints')}
                  <span className="text-xs font-normal text-gray-500 bg-gray-100 px-2 py-1 rounded">(Patient&apos;s reported symptoms)</span>
                </FormLabel>
                <DataMultiSelect
                  type="complaints"
                  value={formData.patient.patientComplaints}
                  onChange={(value) => handlePatientChange('patientComplaints', value)}
                  placeholder="Select patient complaints and symptoms..."
                />
              </div>

              <div className="space-y-3">
                <FormLabel htmlFor="diagnosis" className="text-sm font-semibold flex items-center gap-2">
                  {t('diagnosis')}
                  <span className="text-xs font-normal text-gray-500 bg-gray-100 px-2 py-1 rounded">(Clinical diagnosis)</span>
                </FormLabel>
                <DataMultiSelect
                  type="diagnosis"
                  value={formData.patient.diagnosis}
                  onChange={(value) => handlePatientChange('diagnosis', value)}
                  placeholder="Select diagnosis..."
                />
              </div>
            </CardContent>
          </Card>

          {/* Tests Section */}
          <Card className=" bg-white">
            <CardHeader className="bg-gradient-to-r from-amber-50 to-orange-50 border-b border-gray-100">
              <CardTitle className="text-xl text-gray-900 flex items-center gap-3 font-semibold">
                <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center">
                  <FlaskConical className="w-6 h-6 text-amber-600" />
                </div>
                {t('tests')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6 p-6">
              <div className="space-y-3">
                <FormLabel htmlFor="selectedTests" className="text-sm font-semibold flex items-center gap-2">
                  Laboratory & Diagnostic Tests
                  <span className="text-xs font-normal text-gray-500 bg-gray-100 px-2 py-1 rounded">(Choose from available tests)</span>
                </FormLabel>
                <DataMultiSelect
                  type="tests"
                  value={formData.selectedTests}
                  onChange={updateSelectedTests}
                  placeholder="Select laboratory and diagnostic tests..."
                />
              </div>

              {/* Old Manual Test Entry (kept for backward compatibility) */}
              {formData.tests.length > 0 && (
                <div className="space-y-4 pt-4 border-t border-gray-200">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-gray-700">Manual Test Entries</h4>
                    <span className="text-xs text-gray-500 bg-blue-50 px-2 py-1 rounded">Legacy entries</span>
                  </div>
                  {formData.tests.map((test, index) => (
                    <div key={`${test.id}_${index}`} className="flex gap-4 items-start p-4 border border-gray-200 rounded-lg bg-gray-50 hover:border-amber-300 transition-colors group">
                      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <FormLabel className="text-sm font-semibold">Test Name</FormLabel>
                          <Input
                            value={test.name}
                            onChange={(e) => updateTest(test.id, { name: e.target.value })}
                            placeholder="e.g., Complete Blood Count, X-Ray Chest"
                          />
                        </div>
                        <div className="space-y-2">
                          <FormLabel className="text-sm font-semibold">Special Instructions</FormLabel>
                          <Input
                            value={test.instructions}
                            onChange={(e) => updateTest(test.id, { instructions: e.target.value })}
                            placeholder="Fasting required, Urgent, etc."
                          />
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => removeTest(test.id)}
                        className="text-red-500 border-red-200 hover:bg-red-50 hover:text-red-600 hover:border-red-300 mt-6 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="pt-4 border-t border-gray-100">
                <Button
                  variant="outline"
                  onClick={addTest}
                  className="w-full border-dashed border-2 border-amber-300 text-amber-600 hover:bg-amber-50 hover:border-amber-400 py-3 font-medium transition-colors"
                >
                  <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  Add Manual Test Entry
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Medicines Section */}
          <Card className=" bg-white">
            <CardHeader className="bg-gradient-to-r from-red-50 to-pink-50 border-b border-gray-100">
              <CardTitle className="text-xl text-gray-900 flex items-center gap-3 font-semibold">
                <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                  <span className="text-2xl">💊</span>
                </div>
                {t('medicine')}s
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              <MedicineForm />
            </CardContent>
          </Card>

          {/* Doctor Signature */}
          <Card className=" bg-white">
            <CardHeader className="bg-gradient-to-r from-indigo-50 to-indigo-100 border-b border-gray-100">
              <CardTitle className="text-xl text-gray-900 flex items-center gap-3 font-semibold">
                <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center">
                  <svg className="w-6 h-6 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
                Doctor Information & Signature
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
                <div className="space-y-6">
                  <div className="space-y-3">
                    <FormLabel htmlFor="doctorName" className="text-sm font-semibold">Doctor Name</FormLabel>
                    <Input
                      id="doctorName"
                      value={formData.doctorSignature.name}
                      onChange={(e) => handleDoctorSignatureChange('name', e.target.value)}
                      placeholder="Dr. Anil Kandya"
                    />
                    <p className="text-xs text-gray-500">Appears on the prescription footer and signature section.</p>
                  </div>
                  <div className="space-y-3">
                    <h3 className="text-gray-900 flex items-center gap-2 text-base font-semibold">
                      <span>🗓️</span> Next Review
                    </h3>
                    <p className="text-gray-500 text-sm">Select a follow-up date (today or future only).</p>
                    <DatePicker
                      value={formData.nextReview}
                      onChange={(value) => updateFormData({
                        nextReview: value
                      })}
                      wrapperClassName="w-full sm:w-72"
                    />
                  </div>
                </div>
                <div className="space-y-4">
                  <FormLabel htmlFor="signature" className="text-sm font-semibold text-indigo-900">Digital Signature</FormLabel>
                  <div className="space-y-4">
                    {/* Upload Section */}
                    <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center transition-colors cursor-pointer bg-white shadow-sm hover:border-indigo-400 hover:shadow-md">
                      <input
                        id="signature"
                        type="file"
                        accept="image/*"
                        onChange={handleSignatureUpload}
                        className="hidden"
                      />
                      <label htmlFor="signature" className="cursor-pointer">
                        <div className="flex flex-col items-center justify-center space-y-3">
                          <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center">
                            <svg className="w-6 h-6 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                            </svg>
                          </div>
                          <div>
                            <p className="font-semibold text-gray-700">Upload signature</p>
                            <p className="text-sm font-normal text-gray-500">PNG, JPG up to 5MB</p>
                          </div>
                        </div>
                      </label>
                    </div>

                    {/* Preview Section */}
                    <div className="p-4 border rounded-lg bg-gray-50 shadow-inner">
                      <p className="text-sm font-semibold text-gray-700 mb-3">Signature Preview</p>
                      <div className="flex items-center justify-center min-h-[120px] border-2 border-dashed border-gray-200 rounded-lg bg-white">
                        {formData.doctorSignature.signature ? (
                          <div className="relative group">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={formData.doctorSignature.signature}
                              alt="Doctor Signature"
                              className="max-h-24 max-w-full border border-gray-200 rounded-lg shadow-sm"
                            />
                            <button
                              onClick={() => {
                                updateFormData({ doctorSignature: { ...formData.doctorSignature, signature: "" } })
                              }}
                              className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                            >
                              ×
                            </button>
                          </div>
                        ) : (
                          <div className="text-center py-6">
                            <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                            </svg>
                            <p className="text-gray-400 text-sm font-normal">No signature uploaded</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Remarks Section - Last Section */}
          <Card className=" bg-white">
            <CardHeader className="bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-100">
              <CardTitle className="text-xl text-gray-900 flex items-center gap-3 font-semibold">
                <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
                  <span className="text-2xl">📝</span>
                </div>
                Additional Remarks
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              <div className="space-y-3">
                <FormLabel htmlFor="remarks" className="text-sm font-semibold flex items-center gap-2">
                  {t('remarks')}
                  <span className="text-xs font-normal text-gray-500 bg-gray-100 px-2 py-1 rounded">(Printed at bottom of prescription)</span>
                </FormLabel>
                <Textarea
                  id="remarks"
                  rows={4}
                  value={formData.remarks}
                  onChange={(e) => updateFormData({ remarks: e.target.value })}
                  placeholder="Enter additional remarks, follow-up instructions, special notes for patient..."
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Action Buttons */}
        <div className="mt-10 flex flex-wrap items-center justify-between gap-6 pb-8">
          {/* Navigation Actions */}
          <div className="flex items-center gap-4">
            <Button
              onClick={handlePreview}
              className="bg-[var(--primary-color)] hover:bg-[var(--primary-color-dark)] text-white px-8 py-3 
                       font-semibold text-base btn-hover-lift shadow-lg transition-all duration-200"
            >
              {t('preview')} & Print
            </Button>
          </div>
        </div>
      </div>

      {/* Loading Overlay */}
      {
        isNavigating && (
          <div className="fixed inset-0 bg-black/50 bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white p-8 rounded-lg shadow-lg flex flex-col items-center">
              <Loading />
              <p className="mt-4 text-gray-600">Preparing to Print...</p>
            </div>
          </div>
        )
      }
      {/* {isSavingData && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white p-8 rounded-lg shadow-lg flex flex-col items-center">
            <Loading />
            <p className="mt-4 text-gray-600">Saving Data</p>
          </div>
        </div>
      )} */}

      {/* Success Dialog */}
      <AlertDialog open={showSuccessDialog} onOpenChange={setShowSuccessDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Success</AlertDialogTitle>
            <AlertDialogDescription>
              {successMessage}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setShowSuccessDialog(false)}>
              OK
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div >
  );
};

export default PrescriptionFormPage;