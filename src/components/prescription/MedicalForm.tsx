'use client';

import React from 'react';
import { usePrescription } from '@/contexts/PrescriptionContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormLabel } from '@/components/ui/form';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Medicine } from '@/types';
import { Medicine as MedicineData } from '@/lib/db/dbManager';
import { SearchableMedicineDropdown } from './SearchableMedicineDropdown';

export const MedicineForm = () => {
    const { formData, addMedicine, removeMedicine, updateMedicine, t } = usePrescription();

    // Helper function to format duration display
    const formatDuration = (duration: Medicine['duration']) => {
        const { days, months, years, type } = duration;

        switch (type) {
            case 'days':
                return `${days}d`;
            case 'months':
                return `${months || days}m`;
            case 'years':
                return `${years || days}y`;
            default:
                return `${days}d`;
        }
    };

    const handleMedicineChange = (id: string, field: keyof Medicine, value: string | number | boolean | object) => {
        updateMedicine(id, { [field]: value });
    };

    const handleTimingChange = (id: string, timing: keyof Medicine['timing'], value: number) => {
        const medicine = formData.medicines.find(m => m.id === id);
        if (medicine) {
            updateMedicine(id, {
                timing: {
                    ...medicine.timing,
                    [timing]: value
                }
            });
        }
    };

    const handleDurationChange = (id: string, field: keyof Medicine['duration'], value: number | string | undefined) => {
        const medicine = formData.medicines.find(m => m.id === id);
        if (medicine) {
            updateMedicine(id, {
                duration: {
                    ...medicine.duration,
                    [field]: value
                }
            });
        }
    };

    const handleMedicineSelect = (id: string, medicineData: MedicineData | null, medicineName: string) => {
        if (medicineData) {
            handleMedicineChange(id, 'name', medicineData.name);
            handleMedicineChange(id, 'salt', medicineData.salt);
        } else {
            handleMedicineChange(id, 'name', medicineName);
            // Clear salt if manually typed
            handleMedicineChange(id, 'salt', '');
        }
    };

    const formatTimingDisplay = (timing: Medicine['timing']) => {
        const parts = [];
        if (timing.morning > 0) parts.push(`M: ${timing.morning}`);
        if (timing.afternoon > 0) parts.push(`A: ${timing.afternoon}`);
        if (timing.evening > 0) parts.push(`E: ${timing.evening}`);
        if (timing.night > 0) parts.push(`N: ${timing.night}`);
        return parts.join(', ') || 'No timing set';
    };

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <h3 className="text-lg font-bold text-gray-800">Prescribed Medications</h3>

            </div>
            <div className="relative flex gap-4 mb-2">
                {/* Scrollable Medicines List */}
                <div className="flex-1 overflow-y-auto max-h-[60vh] pr-2 p-2.5 bg-gray-50 rounded-lg border border-gray-200">
                    {formData.medicines.map((medicine, index) => (
                        <Card key={medicine.id} className=" mb-4 border-l-4 border-l-red-500 bg-white shadow-sm">
                            <CardContent className="p-6">
                                <div className="flex justify-between items-start mb-4">
                                    <h4 className="font-semibold text-gray-800">Medicine #{index + 1}</h4>
                                    {formData.medicines.length > 1 && (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => removeMedicine(medicine.id)}
                                            className="text-red-600 hover:text-red-700 bg-white hover:bg-red-300 cursor-pointer"
                                        >
                                            Remove
                                        </Button>
                                    )}
                                </div>

                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                    {/* Left Column - Basic Info */}
                                    <div className="space-y-4">
                                        <div>
                                            <FormLabel className="text-sm font-semibold text-gray-700">
                                                {t('medicine')} *
                                            </FormLabel>
                                            <SearchableMedicineDropdown
                                                value={medicine.name}
                                                onChange={(medicineData, medicineName) => handleMedicineSelect(medicine.id, medicineData, medicineName)}
                                                placeholder="Enter name to get suggestions..."
                                                className="mt-1 bg-white"
                                            />
                                        </div>

                                        {/* Duration Section */}
                                        <div>
                                            <FormLabel className="text-sm font-semibold text-gray-700">
                                                {t('duration')} *
                                            </FormLabel>
                                            <div className="space-y-3 mt-2">
                                                {/* Primary Duration */}
                                                <div className="flex gap-2">
                                                    <Input
                                                        type="number"
                                                        value={medicine.duration.days}
                                                        onChange={(e) => {
                                                            const value = e.target.value;
                                                            // const numericValue = value === '' ? 1 : parseInt(value, 10);
                                                            handleDurationChange(medicine.id, 'days', value)
                                                        }}
                                                        placeholder="Enter number"
                                                        className="bg-white flex-1"
                                                    />
                                                    <Select
                                                        value={medicine.duration.type}
                                                        onValueChange={(value) => handleDurationChange(medicine.id, 'type', value)}
                                                    >
                                                        <SelectTrigger className="bg-white w-[140px]">
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent className="bg-white">
                                                            <SelectItem value="days">{t('days')}</SelectItem>
                                                            <SelectItem value="months">{t('months')}</SelectItem>
                                                            <SelectItem value="years">{t('years')}</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                            </div>
                                        </div>

                                        <div>
                                            <FormLabel className="text-sm font-semibold text-gray-700">
                                                {t('periodicity')}
                                            </FormLabel>
                                            <Select
                                                value={medicine.periodicity}
                                                onValueChange={(value) => handleMedicineChange(medicine.id, 'periodicity', value)}
                                            >
                                                <SelectTrigger className="mt-1 bg-white">
                                                    <SelectValue placeholder={t('selectPeriodicity')} />
                                                </SelectTrigger>
                                                <SelectContent className="bg-white">
                                                    <SelectItem value="Daily">{t('daily')}</SelectItem>
                                                    <SelectItem value="Weekly">{t('weekly')}</SelectItem>
                                                    <SelectItem value="Weekly Twice">{t('weeklyTwice')}</SelectItem>
                                                    <SelectItem value="Alternate Day">{t('alternate')}</SelectItem>
                                                    <SelectItem value="Every 5th Day">{t('every_5th_day')}</SelectItem>
                                                    <SelectItem value="Fortnightly">{t('fortnightly')}</SelectItem>
                                                    <SelectItem value="As needed">{t('asNeeded')}</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>

                                    {/* Right Column - Timing & Food */}
                                    <div className="space-y-4">
                                        <div>
                                            <FormLabel className="text-sm font-semibold text-gray-700 block mb-3">
                                                {t('tabletQuantities')} *
                                            </FormLabel>
                                            <div className="grid grid-cols-2 gap-3">
                                                <div>
                                                    <FormLabel className="text-xs font-medium text-gray-600">{t('morning')}</FormLabel>
                                                    <Input
                                                        type="number"
                                                        min="0"
                                                        step="0.5"
                                                        value={medicine.timing.morning === 0 ? '' : medicine.timing.morning}
                                                        onChange={(e) => {
                                                            const value = e.target.value === '' ? 0 : Number(e.target.value);
                                                            handleTimingChange(medicine.id, 'morning', value);
                                                        }}
                                                        placeholder="0"
                                                        className="bg-white"
                                                    />
                                                </div>
                                                <div>
                                                    <FormLabel className="text-xs font-medium text-gray-600">{t('afternoon')}</FormLabel>
                                                    <Input
                                                        type="number"
                                                        min="0"
                                                        step="0.5"
                                                        value={medicine.timing.afternoon === 0 ? '' : medicine.timing.afternoon}
                                                        onChange={(e) => handleTimingChange(medicine.id, 'afternoon', parseFloat(e.target.value) || 0)}
                                                        placeholder="0"
                                                        className="bg-white"
                                                    />
                                                </div>
                                                <div>
                                                    <FormLabel className="text-xs font-medium text-gray-600">{t('evening')}</FormLabel>
                                                    <Input
                                                        type="number"
                                                        min="0"
                                                        step="0.5"
                                                        value={medicine.timing.evening === 0 ? '' : medicine.timing.evening}
                                                        onChange={(e) => handleTimingChange(medicine.id, 'evening', parseFloat(e.target.value) || 0)}
                                                        placeholder="0"
                                                        className="bg-white"
                                                    />
                                                </div>
                                                <div>
                                                    <FormLabel className="text-xs font-medium text-gray-600">{t('night')}</FormLabel>
                                                    <Input
                                                        type="number"
                                                        min="0"
                                                        step="0.5"
                                                        value={medicine.timing.night === 0 ? '' : medicine.timing.night}
                                                        onChange={(e) => handleTimingChange(medicine.id, 'night', parseFloat(e.target.value) || 0)}
                                                        placeholder="0"
                                                        className="bg-white"
                                                    />
                                                </div>
                                            </div>
                                            <div className="mt-2 text-xs text-gray-500">
                                                Schedule: {formatTimingDisplay(medicine.timing)}
                                            </div>
                                        </div>

                                        <div>
                                            <FormLabel className="text-sm font-semibold text-gray-700">
                                                {t('foodTiming')} *
                                            </FormLabel>
                                            <Select
                                                value={medicine.foodTiming}
                                                onValueChange={(value) => handleMedicineChange(medicine.id, 'foodTiming', value)}
                                            >
                                                <SelectTrigger className="mt-1 bg-white">
                                                    <SelectValue placeholder={t('selectFoodTiming')} />
                                                </SelectTrigger>
                                                <SelectContent className="bg-white">
                                                    <SelectItem value="before">{t('before')}</SelectItem>
                                                    <SelectItem value="after">{t('after')}</SelectItem>
                                                    <SelectItem value="with">{t('with')}</SelectItem>
                                                    <SelectItem value="without">{t('without')}</SelectItem>
                                                    <SelectItem value="with_tea">{t('with_tea')}</SelectItem>
                                                    <SelectItem value="just_for_now">{t('just_for_now')}</SelectItem>
                                                    <SelectItem value="according_to_pain">{t('according_to_pain')}</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="flex items-center space-x-2 p-3 bg-yellow-50 rounded-lg">
                                            <Checkbox
                                                id={`sos-${medicine.id}`}
                                                checked={medicine.sos || false}
                                                onCheckedChange={(checked) => handleMedicineChange(medicine.id, 'sos', checked as boolean)}
                                            />
                                            <FormLabel htmlFor={`sos-${medicine.id}`} className="text-sm font-semibold text-yellow-800">
                                                SOS (If needed only)
                                            </FormLabel>
                                            <div className="text-xs font-normal text-yellow-600">
                                                Check if this medicine should only be taken when needed
                                            </div>
                                        </div>

                                        {/* Preview Box */}
                                        {/* <div className="p-3 bg-gray-50 rounded-lg border">
                                        <h5 className="font-medium text-gray-700 mb-2">Prescription Preview:</h5>
                                        <div className="text-sm space-y-1">
                                            <div><strong>Medicine:</strong> {medicine.name || 'Not specified'}</div>
                                            <div><strong>Duration:</strong> {medicine.duration.days} days {medicine.duration.months ? `+ ${medicine.duration.months} months` : ''}</div>
                                            <div><strong>Timing:</strong> {formatTimingDisplay(medicine.timing)}</div>
                                            <div><strong>Food:</strong> {medicine.foodTiming ?
                                                foodTimingOptions.find(opt => opt.value === medicine.foodTiming)?.label :
                                                'Not specified'}</div>
                                            <div><strong>Periodicity:</strong> {medicine.periodicity || 'Not specified'}</div>
                                            {medicine.sos && <div className="text-yellow-600"><strong>SOS</strong> (If needed)</div>}
                                        </div>
                                    </div> */}
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
                {/* Sticky Add Button */}
                <aside className="sticky top-4 self-start p-2 rounded-lg border border-amber-200 bg-amber-50 min-h-[470px] max-h-[800px] h-full">
                    <div className="flex-1 mb-4">
                        <p className="text-md font-extrabold text-amber-800 mb-2 text-center">Actions</p>
                    </div>
                    <Button
                        onClick={addMedicine}
                        variant="outline"
                        className="border-dashed border-2 bg-white hover:bg-gray-300 cursor-pointer"
                    >
                        {t('addMedicine')}
                    </Button>
                </aside>

            </div>


            {formData.medicines.length === 0 && (
                <div className="text-center py-8 text-black bg-white rounded-lg">
                    <p>No medicines added yet.</p>
                    <Button onClick={addMedicine} className="mt-4 text-black">
                        Add First Medicine
                    </Button>
                </div>
            )}

            {/* Enhanced Summary with Medicine Badges */}
            {formData.medicines.length > 0 && (
                <div className="p-4 bg-gradient-to-r from-emerald-50 to-teal-50 rounded-lg border border-emerald-200 shadow-sm">
                    <div className="flex items-center justify-between mb-3">
                        <h4 className="font-semibold text-emerald-900 flex items-center gap-2">
                            <span className="text-lg">💊</span>
                            Prescription Preview
                        </h4>
                        <div className="flex gap-2 text-xs">
                            <Badge variant="secondary" className="bg-emerald-100 text-emerald-700 hover:bg-emerald-200">
                                {formData.medicines.filter(m => m.name.trim()).length} Total
                            </Badge>
                            {formData.medicines.filter(m => m.sos).length > 0 && (
                                <Badge variant="secondary" className="bg-yellow-100 text-yellow-700 hover:bg-yellow-200">
                                    {formData.medicines.filter(m => m.sos).length} SOS
                                </Badge>
                            )}
                        </div>
                    </div>

                    {/* Medicine Badges Section with Scroll */}
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-xs text-emerald-700 font-medium">
                            <span>Medicines:</span>
                            <span className="text-gray-500">({formData.medicines.filter(m => m.name.trim()).length} added)</span>
                        </div>
                        <div className="max-h-[20vh] overflow-y-auto overflow-x-hidden pr-2 space-y-2 scrollbar-thin scrollbar-thumb-emerald-300 scrollbar-track-emerald-50">
                            {formData.medicines.filter(m => m.name.trim()).map((medicine, index) => {
                                const isComplete = medicine.name.trim() &&
                                    (medicine.timing.morning > 0 || medicine.timing.afternoon > 0 ||
                                        medicine.timing.evening > 0 || medicine.timing.night > 0) &&
                                    medicine.foodTiming && medicine.duration.days > 0;

                                const timingDisplay = `${medicine.timing.morning}-${medicine.timing.afternoon}-${medicine.timing.evening}-${medicine.timing.night}`;

                                return (
                                    <div
                                        key={medicine.id}
                                        className="flex flex-wrap items-center gap-2 p-2 bg-white rounded-md border border-emerald-100 hover:border-emerald-300 transition-colors"
                                    >
                                        <Badge
                                            variant={isComplete ? "default" : "secondary"}
                                            className={`font-medium ${isComplete
                                                ? 'bg-emerald-600 hover:bg-emerald-700'
                                                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                                                }`}
                                        >
                                            {index + 1}. {medicine.name}
                                        </Badge>

                                        <Badge variant="outline" className="text-xs bg-purple-50 text-purple-700 border-purple-200">
                                            {timingDisplay}
                                        </Badge>

                                        <Badge variant="outline" className="text-xs bg-orange-50 text-orange-700 border-orange-200">
                                            {formatDuration(medicine.duration)}
                                        </Badge>

                                        {medicine.foodTiming && (
                                            <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200">
                                                {medicine.foodTiming === 'after' ? 'After Food' :
                                                    medicine.foodTiming === 'before' ? 'Before Food' : 'Empty Stomach'}
                                            </Badge>
                                        )}

                                        {medicine.sos && (
                                            <Badge variant="outline" className="text-xs bg-yellow-50 text-yellow-700 border-yellow-300 font-semibold">
                                                SOS
                                            </Badge>
                                        )}

                                        {!isComplete && (
                                            <Badge variant="outline" className="text-xs bg-red-50 text-red-600 border-red-200">
                                                Incomplete
                                            </Badge>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {/* Quick Stats */}
                        <div className="flex flex-wrap gap-2 pt-2 border-t border-emerald-200 text-xs">
                            <span className="text-emerald-700 font-medium">Status:</span>
                            <Badge variant="secondary" className="bg-green-100 text-green-700">
                                ✓ {formData.medicines.filter(m =>
                                    m.name.trim() &&
                                    (m.timing.morning > 0 || m.timing.afternoon > 0 || m.timing.evening > 0 || m.timing.night > 0) &&
                                    m.foodTiming && m.duration.days > 0
                                ).length} Complete
                            </Badge>
                            {formData.medicines.filter(m =>
                                m.name.trim() && !(
                                    (m.timing.morning > 0 || m.timing.afternoon > 0 || m.timing.evening > 0 || m.timing.night > 0) &&
                                    m.foodTiming && m.duration.days > 0
                                )
                            ).length > 0 && (
                                    <Badge variant="secondary" className="bg-amber-100 text-amber-700">
                                        ⚠ {formData.medicines.filter(m =>
                                            m.name.trim() && !(
                                                (m.timing.morning > 0 || m.timing.afternoon > 0 || m.timing.evening > 0 || m.timing.night > 0) &&
                                                m.foodTiming && m.duration.days > 0
                                            )
                                        ).length} Incomplete
                                    </Badge>
                                )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
