"use client";
import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePrescription } from '@/contexts/PrescriptionContext';
import { Button } from '@/components/ui/button';
import { LanguageToggle } from '@/components/common/LanguageToggle';
import Loading from '@/components/Loading';
import { DoctorEmblem } from '@/components/common/DoctorEmblem';
import { patientInfoRepository, type PatientInfoTemplate } from '@/lib/db';
import { convertImagesToBase64 } from '@/lib/utils';
import { Medicine } from '@/types';
import { Plus } from 'lucide-react';

type PrescriptionTemplate = PatientInfoTemplate;

const PreviewPage = () => {
    const router = useRouter();
    const prescriptionRef = useRef<HTMLDivElement>(null);
    const { formData, t, resetForm, loadedTemplateId, setLoadedTemplateId } = usePrescription();
    const [isGeneratingPDF, setIsGeneratingPDF] = useState(false);
    const [isSavingData, setIsSavingData] = useState(false);
    const [imagesLoaded, setImagesLoaded] = useState(false);

    // Check if running in Tauri environment
    const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

    // Wait for all images to load before showing the preview
    useEffect(() => {
        const loadImages = async () => {
            // Create promises for all critical images
            const imagePromises: Promise<void>[] = [];

            // Watermark image
            const watermarkImg = new window.Image();
            watermarkImg.src = '/heart-watermark.svg';
            imagePromises.push(
                new Promise((resolve) => {
                    watermarkImg.onload = () => resolve();
                    watermarkImg.onerror = () => resolve(); // Resolve even on error to not block
                    setTimeout(() => resolve(), 3000); // Timeout after 3 seconds
                })
            );

            // Doctor emblem image
            const emblemImg = new window.Image();
            emblemImg.src = '/doctor-emblem.svg';
            imagePromises.push(
                new Promise((resolve) => {
                    emblemImg.onload = () => resolve();
                    emblemImg.onerror = () => resolve();
                    setTimeout(() => resolve(), 3000);
                })
            );

            // Wait for all images to load
            await Promise.all(imagePromises);
            setImagesLoaded(true);
        };

        loadImages();
    }, []);


    const handlePrint = async (saveBeforePrint: boolean = true) => {
        if (prescriptionRef.current) {
            setIsGeneratingPDF(true);

            // Auto-save as template before printing (only if we have patient data and saveBeforePrint is true)
            if (saveBeforePrint && formData.patient.patientName.trim()) {
                try {
                    const template: Omit<PrescriptionTemplate, 'id' | 'timestamp'> = {
                        patientName: formData.patient.patientName.trim(),
                        title: formData.patient.title || 'mr',
                        age: formData.patient.age.trim(),
                        gender: formData.patient.gender,
                        weight: formData.patient.weight || '',
                        phone: '', // Not available in current PatientInfo type
                        medicalHistory: formData.patient.medicalHistory.join(', '),
                        drugHistory: formData.patient.drugHistory.join(', '), // Add drug history
                        patientComplaints: formData.patient.patientComplaints.join(', '),
                        diagnosis: formData.patient.diagnosis.join(', '),
                        bloodPressure: formData.vitals.bp.trim(),
                        pulse: parseInt(formData.vitals.pulse) || 0,
                        temperature: parseFloat(formData.vitals.temp) || 0,
                        spo2: parseInt(formData.vitals.spo2) || 0,
                        medicines: formData.medicines.filter(med => med.name.trim() !== '').map(med => ({
                            name: med.name,
                            salt: med.salt || '',
                            dosage: `${med.timing.morning}-${med.timing.afternoon}-${med.timing.evening}-${med.timing.night}`,
                            frequency: med.periodicity,
                            duration: med.duration.days.toString(),
                            durationMonths: med.duration.months,
                            durationType: med.duration.type,
                            timing: `${med.timing.morning}-${med.timing.afternoon}-${med.timing.evening}-${med.timing.night}`,
                            foodTiming: med.foodTiming,
                            sos: med.sos,
                            remark: med.remark,
                        })),
                        tests: [
                            // include manual test entries
                            ...formData.tests.filter(test => test.name.trim() !== '').map(test => ({
                                name: test.name,
                                remark: test.instructions,
                            })),
                            // include selections from multi-select (avoid duplicates)
                            ...((formData.selectedTests || [])
                                .map((name) => ({ name, remark: '' }))
                                .filter((st) => !formData.tests.some((t) => t.name === st.name))),
                        ],
                        remarks: (formData.remarks || '').trim(),
                        nextReview: formData.nextReview || '',
                    };

                    // Save or update template silently (no user notification for auto-save)
                    if (loadedTemplateId) {
                        // Update existing template
                        await patientInfoRepository.update(loadedTemplateId, template);
                    } else {
                        // Save new template only if not already saved
                        const savedTemplate = await patientInfoRepository.create(template);
                        setLoadedTemplateId(savedTemplate.id);
                    }
                } catch (error) {
                    console.warn('Failed to auto-save template:', error);
                    // Don't block printing if auto-save fails
                }
            }

            try {
                if (isTauri) {
                    // Tauri print implementation
                    const { invoke } = await import('@tauri-apps/api/core');

                    // Store original content
                    const originalBody = document.body.innerHTML;
                    const originalTitle = document.title;

                    // Ensure all images are loaded before printing
                    const images = prescriptionRef.current.querySelectorAll('img');
                    const imagePromises = Array.from(images).map(img => {
                        return new Promise((resolve) => {
                            if (img.complete) {
                                resolve(true);
                            } else {
                                img.onload = () => resolve(true);
                                img.onerror = () => resolve(true);
                                setTimeout(() => resolve(true), 2000);
                            }
                        });
                    });

                    await Promise.all(imagePromises);

                    // Get all stylesheets
                    let styles = "";
                    for (let i = 0; i < document.styleSheets.length; i++) {
                        try {
                            const styleSheet = document.styleSheets[i];
                            if (styleSheet.href) {
                                styles += `<link rel="stylesheet" href="${styleSheet.href}">`;
                            } else if (styleSheet.cssRules) {
                                styles += "<style>";
                                for (let j = 0; j < styleSheet.cssRules.length; j++) {
                                    styles += styleSheet.cssRules[j].cssText;
                                }
                                styles += "</style>";
                            }
                        } catch (e) {
                            console.warn("Could not access stylesheet:", e);
                        }
                    }

                    // Create the print-ready HTML content
                    const printContent = `
                        <!DOCTYPE html>
                        <html>
                            <head>
                                <title>Prescription</title>
                                <meta charset="utf-8">
                                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                                ${styles}
                                <style>
                                    * {
                                        -webkit-print-color-adjust: exact;
                                        color-adjust: exact;
                                        box-sizing: border-box;
                                    }
                                    body { 
                                        margin: 0; 
                                        padding: 0; 
                                        font-family: Arial, sans-serif;
                                        background: white;
                                        font-size: 100%;
                                        transform: none;
                                        position: relative;
                                    }
                                    .page-break { 
                                        page-break-after: always;
                                        display: block;
                                        width: 210mm;
                                        min-height: 297mm;
                                        margin: 0;
                                        background: white;
                                        position: relative;
                                        transform: none;
                                        top: 0;
                                        left: 0;
                                        font-family: Arial, sans-serif;
                                    }
                                    .page-break:last-child { 
                                        page-break-after: auto; 
                                    }
                                    table, th, td {
                                        border: 1px solid #000 !important;
                                        border-collapse: collapse !important;
                                    }
                                    /* Ensure inline flex displays work in print */
                                    [style*="display: flex"] {
                                        display: flex !important;
                                    }
                                    [style*="flex-direction: column"] {
                                        flex-direction: column !important;
                                    }
                                    [style*="flex-wrap: wrap"] {
                                        flex-wrap: wrap !important;
                                    }
                                    .text-field {
                                        position: relative;
                                        display: block;
                                        text-align: left;
                                    }
                                    [style*="rgba(220, 38, 38"] {
                                        color: rgba(220, 38, 38, 0.3) !important;
                                        opacity: 1 !important;
                                    }
                                    /* Ensure heart watermark maintains size constraints */
                                    img[alt="HeartWatermark"] {
                                        width: auto !important;
                                        height: 100% !important;
                                        object-fit: contain !important;
                                    }
                                    /* Ensure images print correctly */
                                    img {
                                        display: block !important;
                                        max-width: 70% !important;
                                        height: auto !important;
                                        -webkit-print-color-adjust: exact !important;
                                        color-adjust: exact !important;
                                    }
                                    /* Specifically handle doctor emblem */
                                    img[alt="DoctorEmblem"] {
                                        width: 120px !important;
                                        height: 120px !important;
                                        display: block !important;
                                        margin: 0 auto !important;
                                    }
                                    @media print {
                                        @page {
                                            size: A4;
                                            margin: 0;
                                        }
                                        body { 
                                            margin: 0; 
                                            padding: 0;
                                            transform: none;
                                            position: relative;
                                            font-family: Arial, sans-serif;
                                        }
                                        .page-break { 
                                            page-break-after: always;
                                            margin: 0;
                                            padding: 15mm 20mm;
                                            width: 210mm;
                                            min-height: 297mm;
                                            position: relative;
                                            transform: none;
                                            top: 0;
                                            left: 0;
                                        }
                                        .page-break:last-child { 
                                            page-break-after: auto; 
                                        }
                                        .print\\:hidden {
                                            display: none !important;
                                        }
                                        /* Increase font size and boldness for print */
                                        table td, table th {
                                            font-size: 16px !important;
                                            font-weight: 600 !important;
                                        }
                                        /* Force images to print */
                                        img {
                                            display: block !important;
                                            opacity: 1 !important;
                                            visibility: visible !important;
                                            -webkit-print-color-adjust: exact !important;
                                            color-adjust: exact !important;
                                            max-width: none !important;
                                            width: auto !important;
                                            height: auto !important;
                                        }
                                        /* Ensure inline flex displays work in print */
                                        [style*="display: flex"] {
                                            display: flex !important;
                                        }
                                        [style*="flex-direction: column"] {
                                            flex-direction: column !important;
                                        }
                                        [style*="flex-wrap: wrap"] {
                                            flex-wrap: wrap !important;
                                        }
                                        [style*="align-items"] {
                                            align-items: inherit !important;
                                        }
                                        [style*="justify-content"] {
                                            justify-content: inherit !important;
                                        }
                                    }
                                </style>
                            </head>
                            <body>
                                ${prescriptionRef.current?.innerHTML || ''}
                            </body>
                        </html>
                    `;

                    try {
                        // Convert images to base64 for Tauri printing
                        const printContentWithBase64Images = await convertImagesToBase64(printContent);

                        // Use Tauri's print API
                        await invoke('print_html', { html: printContentWithBase64Images });

                        // Immediate redirect and reload after Tauri print (since it returns when done)
                        resetForm();
                        setIsGeneratingPDF(false);
                        window.location.href = '/prescribe';

                    } catch (tauriError) {
                        console.warn('Tauri print failed, falling back to browser print:', tauriError);
                        // Fallback to browser print if Tauri fails
                        await browserPrint(originalBody, originalTitle, printContent);
                    }
                } else {
                    // Browser print implementation (Next.js)
                    await browserPrint();
                }
            } catch (error) {
                console.error('Print error:', error);
                setIsGeneratingPDF(false);
            }
        }
    };

    // handle save_data
    const handleSaveData = async () => {
        if (prescriptionRef.current) {
            setIsSavingData(true);

            if (formData.patient.patientName.trim() === "") {
                setIsSavingData(false)
                alert("Please enter patient name to save the prescription as template")
                return
            }

            // save as template (only if we have patient data)
            if (formData.patient.patientName.trim()) {
                try {
                    const template: Omit<PrescriptionTemplate, 'id' | 'timestamp'> = {
                        patientName: formData.patient.patientName.trim(),
                        title: formData.patient.title || 'mr',
                        age: formData.patient.age.trim(),
                        gender: formData.patient.gender,
                        weight: formData.patient.weight || '',
                        phone: '', // Not available in current PatientInfo type
                        medicalHistory: formData.patient.medicalHistory.join(', '),
                        drugHistory: formData.patient.drugHistory.join(', '), // Add drug history
                        patientComplaints: formData.patient.patientComplaints.join(', '),
                        diagnosis: formData.patient.diagnosis.join(', '),
                        bloodPressure: formData.vitals.bp.trim(),
                        pulse: parseInt(formData.vitals.pulse) || 0,
                        temperature: parseFloat(formData.vitals.temp) || 0,
                        spo2: parseInt(formData.vitals.spo2) || 0,
                        medicines: formData.medicines.filter(med => med.name.trim() !== '').map(med => ({
                            name: med.name,
                            salt: med.salt || '',
                            dosage: `${med.timing.morning}-${med.timing.afternoon}-${med.timing.evening}-${med.timing.night}`,
                            frequency: med.periodicity,
                            duration: med.duration.days.toString(),
                            durationMonths: med.duration.months,
                            durationType: med.duration.type,
                            timing: `${med.timing.morning}-${med.timing.afternoon}-${med.timing.evening}-${med.timing.night}`,
                            foodTiming: med.foodTiming,
                            sos: med.sos,
                            remark: med.remark,
                        })),
                        tests: [
                            ...formData.tests.filter(test => test.name.trim() !== '').map(test => ({
                                name: test.name,
                                remark: test.instructions,
                            })),
                            ...((formData.selectedTests || [])
                                .map((name) => ({ name, remark: '' }))
                                .filter((st) => !formData.tests.some((t) => t.name === st.name))),
                        ],
                        remarks: (formData.remarks || '').trim(),
                        nextReview: formData.nextReview || '',
                    };

                    // Save or update template
                    if (loadedTemplateId) {
                        // Update existing template
                        await patientInfoRepository.update(loadedTemplateId, template);
                    } else {
                        // Save new template
                        const savedTemplate = await patientInfoRepository.create(template);
                        setLoadedTemplateId(savedTemplate.id);
                    }
                    setIsSavingData(false)
                    alert('Data saved successfully!')
                } catch (error) {
                    setIsSavingData(false)
                    console.error("Error occurred while trying to save data", error)
                    throw new Error("Failed in saving data")
                }
            }

        }

    }


    // Browser print function with redirect handling
    const browserPrint = async (originalBody?: string, originalTitle?: string, printContent?: string) => {
        if (!prescriptionRef.current) return;

        // Ensure all images are loaded before printing
        const images = prescriptionRef.current.querySelectorAll('img');
        const imagePromises = Array.from(images).map(img => {
            return new Promise((resolve) => {
                if (img.complete) {
                    resolve(true);
                } else {
                    img.onload = () => resolve(true);
                    img.onerror = () => resolve(true);
                    setTimeout(() => resolve(true), 2000);
                }
            });
        });

        await Promise.all(imagePromises);

        let _printContent = printContent;

        if (!_printContent) {
            // Get all stylesheets
            let styles = "";
            for (let i = 0; i < document.styleSheets.length; i++) {
                try {
                    const styleSheet = document.styleSheets[i];
                    if (styleSheet.href) {
                        styles += `<link rel="stylesheet" href="${styleSheet.href}">`;
                    } else if (styleSheet.cssRules) {
                        styles += "<style>";
                        for (let j = 0; j < styleSheet.cssRules.length; j++) {
                            styles += styleSheet.cssRules[j].cssText;
                        }
                        styles += "</style>";
                    }
                } catch (e) {
                    console.warn("Could not access stylesheet:", e);
                }
            }

            // Create the print-ready HTML content (same as above)
            _printContent = `
                <!DOCTYPE html>
                <html>
                    <head>
                        <title>Prescription</title>
                        <meta charset="utf-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        ${styles}
                        <style>
                            * {
                                -webkit-print-color-adjust: exact;
                                color-adjust: exact;
                                box-sizing: border-box;
                            }
                            body { 
                                margin: 0; 
                                padding: 0; 
                                font-family: Arial, sans-serif;
                                background: white;
                                font-size: 100%;
                                transform: none;
                                position: relative;
                            }
                            .page-break { 
                                page-break-after: always;
                                display: block;
                                width: 210mm;
                                min-height: 297mm;
                                margin: 0;
                                background: white;
                                position: relative;
                                transform: none;
                                top: 0;
                                left: 0;
                                font-family: Arial, sans-serif;
                            }
                            .page-break:last-child { 
                                page-break-after: auto; 
                            }
                            .vitals-box, [class*="vitals"] {
                                padding: 8px !important;
                                font-size: 11px !important;
                                display: inline-block !important;
                            }
                            table, th, td {
                                border: 1px solid #000 !important;
                                border-collapse: collapse !important;
                            }
                            .text-field {
                                position: relative;
                                display: block;
                                text-align: left;
                            }
                            [style*="rgba(220, 38, 38"] {
                                color: rgba(220, 38, 38, 0.3) !important;
                                opacity: 1 !important;
                            }
                            /* Ensure heart watermark maintains size constraints */
                            img[alt="HeartWatermark"] {
                                width: auto !important;
                                height: 100% !important;
                                object-fit: contain !important;
                            }
                            /* Ensure images print correctly */
                            img {
                                display: block !important;
                                max-width: 70% !important;
                                height: auto !important;
                                -webkit-print-color-adjust: exact !important;
                                color-adjust: exact !important;
                            }
                            /* Specifically handle doctor emblem */
                            img[alt="DoctorEmblem"] {
                                width: 120px !important;
                                height: 120px !important;
                                display: block !important;
                                margin: 0 auto !important;
                            }
                            @media print {
                                @page {
                                    size: A4;
                                    margin: 0;
                                }
                                body { 
                                    margin: 0; 
                                    padding: 0;
                                    transform: none;
                                    position: relative;
                                    font-family: Arial, sans-serif;
                                }
                                .page-break { 
                                    page-break-after: always;
                                    margin: 0;
                                    padding: 15mm 20mm;
                                    width: 210mm;
                                    min-height: 297mm;
                                    position: relative;
                                    transform: none;
                                    top: 0;
                                    left: 0;
                                }
                                .page-break:last-child { 
                                    page-break-after: auto; 
                                }
                                .print\\:hidden {
                                    display: none !important;
                                }
                                /* Force images to print */
                                img {
                                    display: block !important;
                                    opacity: 1 !important;
                                    visibility: visible !important;
                                    -webkit-print-color-adjust: exact !important;
                                    color-adjust: exact !important;
                                    max-width: none !important;
                                    width: auto !important;
                                    height: auto !important;
                                }
                            }
                        </style>
                    </head>
                    <body>
                        ${prescriptionRef.current?.innerHTML || ''}
                    </body>
                </html>
            `;
        }

        // Create iframe for printing to avoid corrupting React DOM
        const printFrame = document.createElement('iframe');
        printFrame.style.position = 'absolute';
        printFrame.style.top = '-10000px';
        printFrame.style.left = '-10000px';
        printFrame.style.width = '0';
        printFrame.style.height = '0';
        printFrame.style.border = 'none';
        document.body.appendChild(printFrame);

        // Set up print completion detection
        let hasRedirected = false;

        const handleRedirect = async () => {
            if (hasRedirected) return;
            hasRedirected = true;

            // Clean up iframe
            if (printFrame && printFrame.parentNode) {
                printFrame.parentNode.removeChild(printFrame);
            }

            // Navigate to home and reload
            window.location.href = '/prescribe';
        };

        // Method 1: Listen for afterprint event (most reliable)
        const handleAfterPrint = () => {
            setTimeout(handleRedirect, 100);
        };

        window.addEventListener('afterprint', handleAfterPrint, { once: true });

        // Method 2: Detect when print dialog closes by monitoring focus
        const originalFocus = document.activeElement;
        let checkCount = 0;

        const checkPrintStatus = () => {
            checkCount++;
            if (document.hasFocus() && document.activeElement === originalFocus) {
                // Window regained focus, likely print dialog closed
                handleRedirect();
            } else if (checkCount < 50) { // max 5 seconds
                setTimeout(checkPrintStatus, 100);
            } else {
                // Fallback timeout
                handleRedirect();
            }
        };

        // Wait for iframe to load, then set content and print
        printFrame.onload = () => {
            const frameDoc = printFrame.contentDocument || printFrame.contentWindow?.document;
            if (frameDoc) {
                frameDoc.open();
                frameDoc.write(_printContent);
                frameDoc.close();
                frameDoc.title = "Prescription";

                // Wait for content and images to load in iframe, then print
                setTimeout(() => {
                    if (printFrame.contentWindow) {
                        printFrame.contentWindow.print();

                        // Start checking for focus return after print dialog appears
                        setTimeout(checkPrintStatus, 200);

                        // Final fallback - redirect after 10 seconds no matter what
                        setTimeout(handleRedirect, 10000);
                    }
                }, 1500);
            }
        };

        // Trigger iframe load
        printFrame.src = 'about:blank';
    };

    const handleBack = () => {
        router.push('/prescribe');
    };

    // Enhanced pagination logic to handle content overflow
    const medicines = formData.medicines.filter(m => m.name.trim());
    // Combine manual test entries and selectedTests (from DataMultiSelect) into one list for rendering
    const manualTests = formData.tests.filter(t => t.name.trim());
    const selectedTests = (formData.selectedTests || []).filter((s) => s && s.trim()).map((name) => ({ id: name, name, instructions: '' }));
    // Merge, avoiding duplicates (manual entries take precedence)
    const tests = [
        ...manualTests,
        ...selectedTests.filter(st => !manualTests.some(mt => mt.name === st.name))
    ];

    const remarks = (formData.remarks || '').trim();

    // Helper function to format duration display
    const formatDuration = (duration: Medicine['duration']) => {
        const { days, months, years, type } = duration;

        switch (type) {
            case 'days':
                return `${days} ${days === 1 ? 'D' : 'd'}`;
            case 'months':
                return `${months || days} ${months === 1 ? 'M' : 'm'}`;
            case 'years':
                return `${years || days} ${years === 1 ? 'Y' : 'y'}`;
            default:
                return `${days} D`;
        }
    };
    const hasRemarks = !!remarks;

    // Helper function to translate periodicity
    const translatePeriodicity = (periodicity: string): string => {
        const periodicityMap: Record<string, string> = {
            'Daily': t('daily'),
            'Weekly': t('weekly'),
            'Alternate Day': t('alternate'),
            'Fortnightly': t('fortnightly'),
            'As needed': t('asNeeded'),
            'Every 5th Day': t('every_5th_day'),
        };
        return periodicityMap[periodicity] || periodicity;
    };

    // Helper function to translate title
    const translateTitle = (title: string): string => {
        const titleMap: Record<string, string> = {
            'mr': t('mr'),
            'mrs': t('mrs'),
            'ms': t('ms'),
            'master': t('master'),
            'baby': t('baby'),
        };
        return titleMap[title] || title;
    };

    // Calculate space requirements - More aggressive space usage
    const MEDICINES_PER_PAGE_FIRST = 10; // More medicines on first page
    const MEDICINES_PER_PAGE_OTHER = 12; // More on subsequent pages
    const TEST_LINES_LIMIT = 8; // Allow more test lines before new page
    // const REMARKS_HEIGHT_LIMIT = 60; // Max remarks height in px - for future use

    // Create pages with intelligent content distribution
    const pages: Array<{
        medicines: typeof formData.medicines;
        tests: typeof formData.tests;
        remarks: string;
        pageNumber: number;
        isLastPage: boolean;
    }> = [];
    let currentMedicineIndex = 0;
    let pageNumber = 1;

    while (currentMedicineIndex < medicines.length || (pageNumber === 1 && (tests.length > 0 || hasRemarks))) {
        const isFirstPage = pageNumber === 1;
        const medicinesPerPage = isFirstPage ? MEDICINES_PER_PAGE_FIRST : MEDICINES_PER_PAGE_OTHER;

        // Get medicines for this page
        const pageMedicines = medicines.slice(currentMedicineIndex, currentMedicineIndex + medicinesPerPage);
        currentMedicineIndex += pageMedicines.length;

        // Determine if this is the last page
        const isLastMedicinePage = currentMedicineIndex >= medicines.length;

        // Calculate remaining space for tests and remarks on last page
        let pageTests: typeof formData.tests = [];
        let pageRemarks = '';
        let needsExtraPage = false;

        if (isLastMedicinePage) {
            // Calculate if we can fit tests and remarks
            const usedMedicineRows = pageMedicines.length;
            const availableRows = medicinesPerPage - usedMedicineRows;
            const spaceForTests = Math.min(availableRows, TEST_LINES_LIMIT);

            // Add tests if they fit
            if (tests.length > 0) {
                if (tests.length <= spaceForTests) {
                    pageTests = tests;
                } else {
                    // Tests don't fit, need extra page
                    needsExtraPage = true;
                }
            }

            // Add remarks if there's space and no overflow
            if (hasRemarks && !needsExtraPage) {
                const remarksLength = remarks.length;
                if (remarksLength > 200) { // Long remarks need extra page
                    needsExtraPage = true;
                } else {
                    pageRemarks = remarks;
                }
            }
        }

        pages.push({
            medicines: pageMedicines,
            tests: pageTests,
            remarks: pageRemarks,
            pageNumber: pageNumber,
            isLastPage: !needsExtraPage && isLastMedicinePage
        });

        // If we need an extra page for tests/remarks
        if (needsExtraPage) {
            pageNumber++;
            pages.push({
                medicines: [],
                tests: tests,
                remarks: remarks,
                pageNumber: pageNumber,
                isLastPage: true
            });
        }

        pageNumber++;
    }

    // Ensure we have at least one page
    if (pages.length === 0) {
        pages.push({
            medicines: [],
            tests: tests,
            remarks: remarks,
            pageNumber: 1,
            isLastPage: true
        });
    }

    // Remove trailing blank page that only contains signature/next review (no medicines/tests/remarks)
    if (pages.length > 1) {
        const lastIdx = pages.length - 1;
        const lastPage = pages[lastIdx];
        if ((lastPage.medicines || []).length === 0 && (lastPage.tests || []).length === 0 && !(lastPage.remarks && lastPage.remarks.trim())) {
            // drop the trailing empty page and mark previous as last
            pages.pop();
            pages[pages.length - 1].isLastPage = true;
        }
    }

    const renderPrescriptionPage = (pageData: { medicines: typeof formData.medicines, tests: typeof formData.tests, remarks: string, pageNumber: number, isLastPage: boolean }) => {
        const { medicines, tests, remarks, pageNumber: pageNum, isLastPage } = pageData;

        return (
            <div
                key={pageNum}
                className="bg-white shadow-lg mx-auto page-break"
                style={{
                    width: '210mm',
                    minHeight: '297mm',
                    maxHeight: '297mm',
                    padding: '15mm 20mm 15mm 20mm', // Reduced bottom padding for more content space
                    position: 'relative',
                    fontFamily: 'Arial, sans-serif',
                    pageBreakAfter: isLastPage ? 'auto' : 'always',
                    overflow: 'visible',
                    display: 'flex',
                    flexDirection: 'column'
                }}
            >
                {/* Heart Watermark */}
                <div style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: 'auto',
                    height: '40%',
                    zIndex: 0,
                    pointerEvents: 'none',
                    userSelect: 'none',
                    opacity: 0.12,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src="/heart-watermark.svg"
                        alt="HeartWatermark"
                        width={600}
                        height={600}
                        style={{
                            width: 'auto',
                            height: '100%',
                            objectFit: 'contain',
                            display: 'block'
                        }}
                    />
                </div>

                {/* Content Container */}
                <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                    {/* Header */}
                    <div style={{ borderBottom: '3px solid #333', paddingBottom: '10px', flexShrink: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div style={{ flex: 1 }}>
                                <h2 style={{ color: '#dc2626', fontSize: '16px', fontWeight: 'bold', margin: '0' }}>
                                    डॉ. अनिल कँडया
                                </h2>
                                <p style={{ margin: '2px 0', fontSize: '12px', fontWeight: 'medium' }}>एम.बी.बी.एस., एम.डी. (मेडिसिन)</p>
                                <p style={{ margin: '2px 0', fontSize: '12px', fontWeight: 'medium' }}>फिजिशियन, हृदय एवं छाती रोग विशेषज्ञ</p>
                                <p style={{ margin: '2px 0', fontSize: '10px', fontWeight: 'normal' }}>निवास : डी.आर.पी. लाईन के सामने,</p>
                                <p style={{ margin: '2px 0', fontSize: '10px', fontWeight: 'normal' }}>सरस्वती नगर, सनावद रोड़, खरगोन (म.प्र.)</p>
                                <p style={{ margin: '2px 0', fontSize: '10px', fontWeight: 'normal' }}>रजि. नं. : 3860</p>
                            </div>

                            <div style={{
                                flex: 0,
                                padding: '0 20px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                minWidth: '140px',
                                minHeight: '140px',
                                maxWidth: '150px',
                                maxHeight: '150px'
                            }}>
                                <DoctorEmblem />
                            </div>

                            <div style={{ flex: 1, textAlign: 'right' }}>
                                <h3 style={{ fontSize: '16px', fontWeight: 'bold', margin: '0', color: '#dc2626' }}>
                                    DR. ANIL KANDYA
                                </h3>
                                <p style={{ margin: '2px 0', fontSize: '12px', fontWeight: 'medium' }}>M.B.B.S., M.D. (Medicine)</p>
                                <p style={{ margin: '2px 0', fontSize: '12px', fontWeight: 'medium' }}>Consultant Physician</p>
                                <p style={{ margin: '2px 0', fontSize: '12px', fontWeight: 'medium' }}>& Cardiologist</p>
                                <p style={{ margin: '2px 0', fontSize: '10px', fontWeight: 'normal' }}><span style={{ fontWeight: 'bold' }}>Add. :</span> Saraswati Nagar,</p>
                                <p style={{ margin: '2px 0', fontSize: '10px', fontWeight: 'normal' }}>Sanawad Rod, Khargone (M.P.)</p>
                                <p style={{ margin: '2px 0', fontSize: '10px', fontWeight: 'normal' }}>Reg. No. 3860</p>
                            </div>
                        </div>

                        <div style={{
                            marginTop: '10px',
                            textAlign: 'center',
                            backgroundColor: '#f8f9fa',
                            padding: '5px',
                            fontSize: '11px',
                            border: '1px solid #dee2e6',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontWeight: 'medium'
                        }}>
                            मिलने का समय : प्रातः 9 से 1 बजे तक एवं 2 से सायं 7 बजे तक <span style={{ margin: '0 10px' }}><Plus size={16} strokeWidth={3} color='#dc2626' /></span> ब्लड शुगर एवं ई.सी.जी. सुविधा उपलब्ध है।
                        </div>
                    </div>

                    {/* Patient Details - only on first page */}
                    {pageNum === 1 && (
                        <div style={{ marginTop: '15px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                                <div style={{ flex: 1, minWidth: '220px' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '4px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                            <div style={{ display: 'flex', alignItems: 'center' }}>
                                                <h3 style={{ fontWeight: 'semibold', fontSize: '14px', minWidth: '40px' }}>नाम :</h3>
                                                <p style={{ borderBottom: '1px dotted #666', minWidth: '170px', fontSize: '14px', fontWeight: 'medium' }}>
                                                    {translateTitle(formData.patient.title)} {formData.patient.patientName}
                                                </p>
                                            </div>
                                            <div style={{ display: 'flex' }}>
                                                <h3 style={{ fontWeight: 'semibold', fontSize: '14px', minWidth: '40px' }}>लिंग :</h3>
                                                <p style={{ borderBottom: '1px dotted #666', minWidth: '60px', fontSize: '14px', fontWeight: 'medium' }}>{formData.patient.gender}</p>
                                            </div>
                                            <div style={{ display: 'flex' }}>
                                                <h3 style={{ fontWeight: 'semibold', fontSize: '14px', minWidth: '40px' }}>उम्र :</h3>
                                                <p style={{ borderBottom: '1px dotted #666', minWidth: '60px', fontSize: '14px', fontWeight: 'medium' }}>{formData.patient.age}</p>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Vital Signs - Single/Double Line Format */}
                                    <div style={{ marginTop: '12px', padding: '6px', paddingLeft: "0px" }}>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '15px', fontSize: '11px', fontWeight: 'medium' }}>
                                            <span><strong>Weight:</strong> {formData.patient.weight || '-'}</span>
                                            <span><strong>SpO₂:</strong> {formData.vitals.spo2 || '-'} %</span>
                                            <span><strong>Pulse:</strong> {formData.vitals.pulse || '-'} /min</span>
                                            <span><strong>Temp:</strong> {formData.vitals.temp || '-'} °F</span>
                                            <span><strong>BP:</strong> {formData.vitals.bp || '-'}</span>
                                        </div>
                                    </div>

                                    {/* Medical History, Patient Complaints and Diagnosis */}
                                    <div style={{ marginTop: '8px' }}>
                                        <div style={{ marginBottom: '8px' }}>
                                            <strong style={{ fontWeight: 'bold', fontSize: '12px' }}>{t('medicalHistory')}: </strong>
                                            <span style={{ fontSize: '11px', fontWeight: 'normal' }}>
                                                {Array.isArray(formData.patient.medicalHistory) && formData.patient.medicalHistory.length > 0 ? formData.patient.medicalHistory.join(', ') : ''}
                                            </span>
                                        </div>
                                        <div style={{ marginBottom: '8px' }}>
                                            <strong style={{ fontWeight: 'bold', fontSize: '12px' }}>{t('patientComplaints')}: </strong>
                                            <span style={{ fontSize: '11px', fontWeight: 'normal' }}>
                                                {Array.isArray(formData.patient.patientComplaints) && formData.patient.patientComplaints.length > 0 ? formData.patient.patientComplaints.join(', ') : ''}
                                            </span>
                                        </div>
                                        <div style={{ marginBottom: '8px' }}>
                                            <strong style={{ fontWeight: 'bold', fontSize: '12px' }}>{t('diagnosis')}: </strong>
                                            <span style={{ fontSize: '11px', fontWeight: 'normal' }}>
                                                {Array.isArray(formData.patient.diagnosis) && formData.patient.diagnosis.length > 0 ? formData.patient.diagnosis.join(', ') : ''}
                                            </span>
                                        </div>
                                        <div style={{ marginBottom: '8px' }}>
                                            <strong style={{ fontWeight: 'bold', fontSize: '12px' }}>{t('drugHistory')}: </strong>
                                            <span style={{ fontSize: '11px', fontWeight: 'normal' }}>
                                                {Array.isArray(formData.patient.drugHistory) && formData.patient.drugHistory.length > 0 ? formData.patient.drugHistory.join(', ') : ''}
                                            </span>
                                        </div>
                                    </div>

                                    <div style={{ fontSize: '24px', color: '#dc2626', fontWeight: 'bold', marginBottom: '5px' }}>℞</div>
                                </div>

                                <div style={{ textAlign: 'right', fontSize: '14px', minWidth: '160px' }}>
                                    <div style={{ marginBottom: '5px' }}>
                                        <span style={{ fontWeight: 'semibold' }}>दिनांक : </span>
                                        <span style={{ borderBottom: '1px dotted #666', display: 'inline-block', minWidth: '100px', fontWeight: 'medium' }}>
                                            {formData.date}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Prescription Table */}
                    <div style={{ marginTop: pageNum === 1 ? '20px' : '40px', minHeight: '300px' }}>
                        {medicines.length > 0 && (
                            <table style={{
                                width: '100%',
                                borderCollapse: 'collapse',
                                border: '1px solid #000',
                                fontSize: '10px'
                            }}>
                                <thead>
                                    <tr style={{ backgroundColor: '#f8f9fa' }}>
                                        <th style={{
                                            border: '1px solid #000',
                                            padding: '4px 3px',
                                            fontWeight: 'semibold',
                                            textAlign: 'left',
                                            width: '28%',
                                            fontSize: '10px'
                                        }} rowSpan={2}>
                                            {t('medication')}
                                        </th>
                                        <th style={{
                                            border: '1px solid #000',
                                            padding: '4px 3px',
                                            fontWeight: 'semibold',
                                            textAlign: 'center',
                                            width: '24%',
                                            fontSize: '10px'
                                        }} colSpan={4}>
                                            {t('dosage')}
                                        </th>
                                        <th style={{
                                            border: '1px solid #000',
                                            padding: '4px 3px',
                                            fontWeight: 'semibold',
                                            alignItems: 'center',
                                            textAlign: 'center',
                                            width: '12%',
                                            fontSize: '10px'
                                        }} rowSpan={2}>
                                            {t('food')}
                                        </th>
                                        <th style={{
                                            border: '1px solid #000',
                                            padding: '4px 3px',
                                            fontWeight: 'semibold',
                                            alignItems: 'center',
                                            textAlign: 'center',
                                            fontSize: '10px',
                                            width: '36%'
                                        }} rowSpan={2}>
                                            {t('frequencyDuration')}
                                        </th>
                                    </tr>
                                    <tr style={{ backgroundColor: '#f8f9fa' }}>
                                        <th style={{ border: '1px solid #000', padding: '4px 3px', fontWeight: 'semibold', textAlign: 'center', width: '6%', fontSize: '10px' }}>{t('mor')}</th>
                                        <th style={{ border: '1px solid #000', padding: '4px 3px', fontWeight: 'semibold', textAlign: 'center', width: '6%', fontSize: '10px' }}>{t('noon')}</th>
                                        <th style={{ border: '1px solid #000', padding: '4px 3px', fontWeight: 'semibold', textAlign: 'center', width: '6%', fontSize: '10px' }}>{t('eve')}</th>
                                        <th style={{ border: '1px solid #000', padding: '4px 3px', fontWeight: 'semibold', textAlign: 'center', width: '6%', fontSize: '10px' }}>{t('night')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {medicines.map((medicine, index) => (
                                        <tr key={medicine.id}>
                                            <td style={{
                                                border: '1px solid #000',
                                                padding: '4px 3px',
                                                verticalAlign: 'top'
                                            }}>
                                                <div style={{ fontWeight: 'semibold', fontSize: '10px' }}>
                                                    {((pageNum - 1) * (pageNum === 1 ? MEDICINES_PER_PAGE_FIRST : MEDICINES_PER_PAGE_OTHER)) + index + 1}. {medicine.name}
                                                </div>
                                                {medicine.salt && (
                                                    <div style={{ fontSize: '9px', color: '#666', fontStyle: 'italic', marginTop: '2px', fontWeight: 'normal' }}>
                                                        ({medicine.salt})
                                                    </div>
                                                )}
                                                {medicine.sos && (
                                                    <div style={{ fontSize: '9px', color: '#dc2626', fontWeight: 'bold', marginTop: '1px' }}>
                                                        (SOS)
                                                    </div>
                                                )}
                                            </td>
                                            <td style={{
                                                border: '1px solid #000',
                                                padding: '4px 3px',
                                                alignItems: 'center',
                                                textAlign: 'center',
                                                verticalAlign: 'top',
                                                fontSize: '11px',
                                                fontWeight: 'bold'
                                            }}>
                                                {medicine.timing.morning || 0}
                                            </td>
                                            <td style={{
                                                border: '1px solid #000',
                                                padding: '4px 3px',
                                                alignItems: 'center',
                                                textAlign: 'center',
                                                verticalAlign: 'top',
                                                fontSize: '11px',
                                                fontWeight: 'bold'
                                            }}>
                                                {medicine.timing.afternoon || 0}
                                            </td>
                                            <td style={{
                                                border: '1px solid #000',
                                                padding: '4px 3px',
                                                alignItems: 'center',
                                                textAlign: 'center',
                                                verticalAlign: 'top',
                                                fontSize: '11px',
                                                fontWeight: 'bold'
                                            }}>
                                                {medicine.timing.evening || 0}
                                            </td>
                                            <td style={{
                                                border: '1px solid #000',
                                                padding: '4px 3px',
                                                alignItems: 'center',
                                                textAlign: 'center',
                                                verticalAlign: 'top',
                                                fontSize: '11px',
                                                fontWeight: 'bold'
                                            }}>
                                                {medicine.timing.night || 0}
                                            </td>
                                            <td style={{
                                                border: '1px solid #000',
                                                padding: '4px 3px',
                                                alignItems: 'center',
                                                textAlign: 'center',
                                                verticalAlign: 'top',
                                                fontSize: '10px',
                                                fontWeight: 'normal'
                                            }}>
                                                {t(medicine.foodTiming)}
                                            </td>
                                            <td style={{
                                                border: '1px solid #000',
                                                padding: '4px 3px',
                                                alignItems: 'center',
                                                textAlign: 'center',
                                                verticalAlign: 'top',
                                                fontSize: '10px',

                                            }}>
                                                <div style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    gap: '4px'
                                                }}>
                                                    <div style={{ fontWeight: 'medium' }}>
                                                        {translatePeriodicity(medicine.periodicity)}
                                                    </div>
                                                    <span style={{ fontSize: '8px', opacity: 0.6 }}>•</span>
                                                    <div style={{ fontSize: '10px', fontWeight: 'normal' }}>
                                                        {formatDuration(medicine.duration)}
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}

                        {/* Tests on this page */}
                        {tests.length > 0 && (
                            <div style={{ marginTop: '16px' }}>
                                <div style={{ fontSize: '10px', lineHeight: '1.6' }}>
                                    <strong style={{ fontWeight: 'bold', fontSize: '12px' }}>{t('tests')}: </strong>
                                    <span style={{ fontSize: '11px' }}>
                                        {tests.map((test, index) => (
                                            <span key={test.id}>
                                                {test.name}{test.instructions && ` (${test.instructions})`}{index < tests.length - 1 ? ', ' : ''}
                                            </span>
                                        ))}
                                    </span>
                                </div>
                            </div>
                        )}

                        {/* Remarks Section - Full Width (only on last page) */}
                        {isLastPage && remarks && (
                            <div style={{ marginTop: '16px' }}>
                                <div style={{ fontSize: '10px', lineHeight: '1.5' }}>
                                    <strong style={{ fontWeight: 'bold', fontSize: '12px' }}>{t('remarks')}: </strong>
                                    <span style={{ fontSize: '11px' }}>{remarks}</span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Signature and Next Review Section - Positioned right above footer */}
                <div style={{
                    position: 'absolute',
                    bottom: '38mm',
                    left: '20mm',
                    right: '20mm',
                    zIndex: 2
                }}>
                    <div style={{
                        borderTop: '1px solid #ddd',
                        paddingTop: '8px',
                        paddingBottom: '8px',
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                        backgroundColor: 'white'
                    }}>
                        <div style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            maxWidth: '600px',
                            width: '100%',
                            gap: '40px'
                        }}>
                            {/* Next Review on Left - only on last page */}
                            <div style={{ flex: 1, textAlign: 'left' }}>
                                {isLastPage && (
                                    <div style={{ fontSize: '11px' }}>
                                        <strong style={{ fontWeight: 'bold' }}>Next Review: </strong>
                                        <span style={{ display: 'inline-block', minWidth: '120px' }}>
                                            {formData.nextReview ? new Date(formData.nextReview).toLocaleDateString('en-GB') : '_______________'}
                                        </span>
                                    </div>
                                )}
                            </div>

                            {/* Doctor Signature on Right - always show */}
                            <div style={{ textAlign: 'right', minWidth: '160px' }}>
                                {/* Signature image (use default if not provided) */}
                                <div style={{ marginBottom: '5px' }}>
                                    <div style={{
                                        width: '120px',
                                        height: '40px',
                                        border: '1px solid #ddd',
                                        backgroundImage: `url(${formData.doctorSignature.signature})`,
                                        backgroundSize: 'contain',
                                        backgroundRepeat: 'no-repeat',
                                        backgroundPosition: 'center',
                                        marginLeft: 'auto'
                                    }}></div>
                                </div>
                                <div style={{ fontSize: '11px', lineHeight: '1.3' }}>
                                    <div style={{ fontWeight: 'bold', paddingBottom: '2px' }}>
                                        {formData.doctorSignature.name || 'Dr. Anil Kandya'}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                {/* Footer - always show on every page */}
                <div style={{
                    position: 'absolute',
                    bottom: '12mm',
                    left: '20mm',
                    right: '20mm',
                    borderTop: '2px solid #333',
                    paddingTop: '8px',
                    fontSize: '11px'
                }}>
                    <div style={{ textAlign: 'center', marginBottom: '5px' }}>
                        <span style={{ color: '#dc2626' }}>✱</span> ध्यान दें : मरीज आने से पूर्व इन नंबर पर संपर्क करके ही आये –
                        <span style={{
                            border: '1px solid #333',
                            padding: '1px 6px',
                            margin: '0 3px',
                            fontWeight: 'bold'
                        }}>
                            98267-40200
                        </span>
                        <span style={{
                            border: '1px solid #333',
                            padding: '1px 6px',
                            fontWeight: 'bold'
                        }}>
                            07282-356251
                        </span>
                    </div>
                    <div style={{ fontSize: '10px', textAlign: 'center', marginBottom: '3px' }}>
                        <span style={{ color: '#dc2626' }}>✱</span> रविवार दोप. 2 बजे बाद अवकाश रहेगा ।
                    </div>
                    <div style={{
                        fontSize: '10px',
                        textAlign: 'center',
                        border: '1px dashed #666',
                        padding: '3px',
                        display: 'inline-block',
                        width: '100%'
                    }}>
                        <span style={{ color: '#dc2626' }}>✱</span> कृपया पुराना पेपर हमेशा साथ में लायें
                        <span style={{ color: '#dc2626', marginLeft: '10px' }}>✱</span> इमरजेंसी पेशेंट सीधे अस्पताल जायें ।
                    </div>
                    <div style={{ textAlign: 'center', fontSize: '10px', marginTop: '3px' }}>
                        यह दवा की पर्ची 15 दिनों के लिए वैध है ।
                    </div>
                </div>
            </div>
        );
    };

    // Show loading screen while images are being loaded
    if (!imagesLoaded) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="text-center">
                    <div className='flex items-center justify-center'>
                        <Loading />
                    </div>
                    <p className="mt-4 text-gray-600 text-lg">Loading prescription preview...</p>
                    <p className="mt-2 text-gray-500 text-sm">Please wait while we load all images</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-100 p-4">
            <div className="max-w-7xl mx-auto">
                {/* Controls */}
                <div className="mb-6 flex justify-between items-center print:hidden">
                    <div className="flex gap-2">
                        <Button onClick={handleBack} variant="outline">
                            {t('back')}
                        </Button>
                    </div>
                    <LanguageToggle />
                    <div className='flex gap-2'>
                        <Button onClick={handleSaveData} disabled={isSavingData} className='bg-emerald-500 text-white font-medium cursor-pointer hover:bg-emerald-600' variant="outline">
                            {isSavingData ? 'Saving...' : t('save_data')}
                        </Button>
                        <Button onClick={() => handlePrint(true)} disabled={isGeneratingPDF} className='bg-green-400 text-white font-medium cursor-pointer hover:bg-green-600' variant="outline">
                            {isGeneratingPDF ? 'Processing...' : t('save_and_print')}
                        </Button>
                        <Button onClick={() => handlePrint(false)} disabled={isGeneratingPDF} className='bg-purple-400 text-white font-medium cursor-pointer hover:bg-purple-600' variant="outline">
                            {isGeneratingPDF ? 'Processing...' : t('print_only')}
                        </Button>
                    </div>
                </div>

                {/* Prescription Pages */}
                <div ref={prescriptionRef}>
                    {pages.map((page) =>
                        renderPrescriptionPage(page)
                    )}
                </div>
            </div>

            {/* Print Styles */}
            <style jsx>{`
                @media print {
                    .print\\:hidden {
                        display: none !important;
                    }
                    .page-break {
                        page-break-after: always;
                        margin: 0;
                        padding: 0;
                        width: 210mm !important;
                        min-height: 297mm !important;
                        max-width: 210mm !important;
                        box-shadow: none !important;
                        transform: none !important;
                        position: relative !important;
                        top: 0 !important;
                        left: 0 !important;
                    }
                    .page-break:last-child {
                        page-break-after: auto;
                    }
                    body {
                        -webkit-print-color-adjust: exact;
                        color-adjust: exact;
                        margin: 0;
                        padding: 0;
                        font-family: Arial, sans-serif;
                    }
                    * {
                        -webkit-print-color-adjust: exact;
                        color-adjust: exact;
                        box-sizing: border-box;
                    }
                    .bg-gray-100 {
                        background: white !important;
                    }
                    /* Ensure vital signs box renders properly */
                    .vitals-box, [style*="border: 1px solid #ccc"] {
                        padding: 8px !important;
                        font-size: 11px !important;
                    }
                    /* Prevent wrapping of patient detail inline fields in print */
                    .patient-details-inline {
                        display: flex !important;
                        gap: 8px !important;
                        align-items: center !important;
                        flex-wrap: wrap !important;
                    }
                    /* Ensure tables render with borders */
                    table, th, td {
                        border: 1px solid #000 !important;
                        border-collapse: collapse !important;
                    }
                    /* Fix text positioning */
                    .text-offset-fix, .text-field {
                        position: relative;
                        display: block;
                        text-align: left;
                    }
                    /* Ensure heart watermark renders properly */
                    [style*="rgba(220, 38, 38"] {
                        color: rgba(220, 38, 38, 0.3) !important;
                        font-family: Arial, sans-serif !important;
                    }
                    /* Watermark size constraints */
                    img[alt="HeartWatermark"] {
                        width: auto !important;
                        height: 100% !important;
                        object-fit: contain !important;
                        opacity: 0.12 !important;
                    }
                }
                
                /* Ensure PDF rendering consistency */
                .page-break {
                    box-sizing: border-box;
                    overflow: visible;
                    font-family: Arial, sans-serif;
                }
                
                .page-break * {
                    box-sizing: border-box;
                }
                
                /* Improve vital signs display */
                .vitals-box {
                    display: inline-block;
                    padding: 8px;
                    font-size: 11px;
                }
                
                /* Ensure proper text positioning */
                .text-field {
                    position: relative;
                    display: inline-block;
                    text-align: left;
                }
            `}</style>

            {isGeneratingPDF && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                    <div className="bg-white p-8 rounded-lg shadow-lg flex flex-col items-center">
                        <Loading />
                        <p className="mt-4 text-gray-600">Preparing prescription for print...</p>
                        <p className="text-sm text-gray-500">Loading images and content</p>
                    </div>
                </div>
            )}
            {isSavingData && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                    <div className="bg-white p-8 rounded-lg shadow-lg flex flex-col items-center">
                        <Loading />
                        <p className="mt-4 text-gray-600">Saving Data</p>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PreviewPage;