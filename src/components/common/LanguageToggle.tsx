'use client';

import React from 'react';
import { usePrescription } from '@/contexts/PrescriptionContext';
import { Button } from '@/components/ui/button';

export const LanguageToggle: React.FC = () => {
    const { language, setLanguage } = usePrescription();

    return (
        <div className="flex gap-2">
            <Button
                onClick={() => setLanguage('hindi')}
                className={`px-4 py-2 rounded-md font-medium transition-colors cursor-pointer ${language === 'hindi'
                    ? 'bg-green-200 text-black border-2 border-green-400 hover:bg-green-300'
                    : 'bg-white text-black border-2 border-gray-300 hover:bg-gray-50'
                    }`}
                size="default"
            >
                हिंदी
            </Button>
            <Button
                onClick={() => setLanguage('english')}
                className={`px-4 py-2 rounded-md font-medium transition-colors cursor-pointer ${language === 'english'
                    ? 'bg-green-200 text-black border-2 border-green-400 hover:bg-green-300'
                    : 'bg-white text-black border-2 border-gray-300 hover:bg-gray-50'
                    }`}
                size="default"
            >
                English
            </Button>
        </div>
    );
};
