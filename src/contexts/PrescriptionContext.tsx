'use client';

import React, { createContext, useContext, useState, ReactNode } from 'react';
import { PrescriptionFormData, Language, Medicine, Test } from '@/types';
import { translations } from '@/lib/translations';

interface PrescriptionContextType {
    formData: PrescriptionFormData;
    language: Language;
    loadedTemplateId: string | null;
    updateFormData: (data: Partial<PrescriptionFormData>) => void;
    setLanguage: (lang: Language) => void;
    setLoadedTemplateId: (id: string | null) => void;
    addMedicine: () => void;
    removeMedicine: (id: string) => void;
    updateMedicine: (id: string, medicine: Partial<Medicine>) => void;
    addTest: () => void;
    removeTest: (id: string) => void;
    updateTest: (id: string, test: Partial<Test>) => void;
    updateSelectedTests: (tests: string[]) => void;
    updateSelectedComplaints: (complaints: string[]) => void;
    updateSelectedDiagnosis: (diagnosis: string[]) => void;
    updateSelectedMedicalHistory: (medicalHistory: string[]) => void;
    updateSelectedDrugHistory: (drugHistory: string[]) => void;
    t: (key: keyof typeof translations.hindi) => string;
    resetForm: () => void;
}

const defaultFormData: PrescriptionFormData = {
    patient: {
        title: 'mr',
        patientName: '',
        age: '',
        gender: '',
        weight: '',
        // height: '',
        allergies: '',
        diagnosis: [],
        patientComplaints: [],
        followUpDate: '',
        medicalHistory: [],
        drugHistory: [],
    },
    vitals: {
        spo2: '',
        pulse: '',
        temp: '',
        bp: '',
    },
    medicines: [{
        id: '1',
        name: '',
        salt: '',
        duration: {
            days: 1,
            months: undefined,
            years: undefined,
            type: 'days',
        },
        remark: '',
        timing: {
            morning: 0,
            afternoon: 0,
            evening: 0,
            night: 0,
        },
        foodTiming: 'after',
        sos: false,
        periodicity: 'Daily',
        startDate: new Date().toISOString().split('T')[0],
    }],
    tests: [],
    selectedTests: [],
    date: new Date().toLocaleDateString('en-GB'),
    nextReview: '',
    doctorSignature: {
        name: 'Dr. Anil Kandya',
        // qualification: 'M.B.B.S., M.D. (Medicine)',
        // registrationNo: 'Reg. No. 3860',
        signature: '',
    },
    remarks: '',
};

const PrescriptionContext = createContext<PrescriptionContextType | undefined>(undefined);

export const PrescriptionProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [formData, setFormData] = useState<PrescriptionFormData>(defaultFormData);
    const [language, setLanguage] = useState<Language>('english');
    const [loadedTemplateId, setLoadedTemplateId] = useState<string | null>(null);

    const updateFormData = (data: Partial<PrescriptionFormData>) => {
        setFormData(prev => ({ ...prev, ...data }));
    };

    const addMedicine = () => {
        const newMedicine: Medicine = {
            id: Date.now().toString(),
            name: '',
            salt: '',
            duration: {
                days: 1,
                months: undefined,
                years: undefined,
                type: 'days',
            },
            remark: '',
            timing: {
                morning: 0,
                afternoon: 0,
                evening: 0,
                night: 0,
            },
            foodTiming: 'after',
            sos: false,
            periodicity: 'Daily',
            startDate: new Date().toISOString().split('T')[0],
        };
        setFormData(prev => ({
            ...prev,
            medicines: [...prev.medicines, newMedicine],
        }));
    };

    const removeMedicine = (id: string) => {
        setFormData(prev => ({
            ...prev,
            medicines: prev.medicines.filter(med => med.id !== id),
        }));
    };

    const updateMedicine = (id: string, medicine: Partial<Medicine>) => {
        setFormData(prev => ({
            ...prev,
            medicines: prev.medicines.map(med =>
                med.id === id ? { ...med, ...medicine } : med
            ),
        }));
    };

    const addTest = () => {
        const newTest: Test = {
            id: Date.now().toString(),
            name: '',
            instructions: '',
        };
        setFormData(prev => ({
            ...prev,
            tests: [...prev.tests, newTest],
        }));
    };

    const removeTest = (id: string) => {
        setFormData(prev => ({
            ...prev,
            tests: prev.tests.filter(test => test.id !== id),
        }));
    };

    const updateTest = (id: string, test: Partial<Test>) => {
        setFormData(prev => ({
            ...prev,
            tests: prev.tests.map(t =>
                t.id === id ? { ...t, ...test } : t
            ),
        }));
    };

    const updateSelectedTests = (tests: string[]) => {
        setFormData(prev => ({
            ...prev,
            selectedTests: tests,
        }));
    };

    const updateSelectedComplaints = (complaints: string[]) => {
        setFormData(prev => ({
            ...prev,
            patient: {
                ...prev.patient,
                patientComplaints: complaints,
            },
        }));
    };

    const updateSelectedDiagnosis = (diagnosis: string[]) => {
        setFormData(prev => ({
            ...prev,
            patient: {
                ...prev.patient,
                diagnosis: diagnosis,
            },
        }));
    };

    const updateSelectedDrugHistory = (drugHistory: string[]) => {
        setFormData(prev => ({
            ...prev,
            patient: {
                ...prev.patient,
                drugHistory,
            },
        }));
    };

    const updateSelectedMedicalHistory = (medicalHistory: string[]) => {
        setFormData(prev => ({
            ...prev,
            patient: {
                ...prev.patient,
                medicalHistory: medicalHistory,
            },
        }));
    };

    const t = (key: keyof typeof translations.hindi): string => {
        return translations[language][key] || translations['hindi'][key] || key;
    };

    const resetForm = () => {
        setFormData(defaultFormData);
        setLoadedTemplateId(null);
    };

    return (
        <PrescriptionContext.Provider
            value={{
                formData,
                language,
                updateFormData,
                setLanguage,
                addMedicine,
                removeMedicine,
                updateMedicine,
                addTest,
                removeTest,
                updateTest,
                updateSelectedTests,
                updateSelectedComplaints,
                updateSelectedDiagnosis,
                updateSelectedDrugHistory,
                updateSelectedMedicalHistory,
                t,
                resetForm,
                loadedTemplateId,
                setLoadedTemplateId,
            }}
        >
            {children}
        </PrescriptionContext.Provider>
    );
};

export const usePrescription = () => {
    const context = useContext(PrescriptionContext);
    if (context === undefined) {
        throw new Error('usePrescription must be used within a PrescriptionProvider');
    }
    return context;
};