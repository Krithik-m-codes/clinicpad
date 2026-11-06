'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Search, Calendar, User, FileText, Activity, Eye, Trash2, Download, RefreshCw, Heart, Pill, TestTube, Clock, ChevronRight, Sparkles, SquareMousePointer } from 'lucide-react';
import { patientInfoRepository, type PatientInfoTemplate } from '@/lib/db';
import { usePrescription } from '@/contexts/PrescriptionContext';
import { formatDate, formatDateShort } from '@/lib/utils';

type PrescriptionTemplate = PatientInfoTemplate;

export default function PatientInfosPage() {
    const router = useRouter();
    const { updateFormData, setLoadedTemplateId } = usePrescription();

    // Data state
    const [templates, setTemplates] = useState<PrescriptionTemplate[]>([]);
    const [filteredTemplates, setFilteredTemplates] = useState<PrescriptionTemplate[]>([]);
    const [selectedTemplate, setSelectedTemplate] = useState<PrescriptionTemplate | null>(null);
    const [loading, setLoading] = useState(true);
    const [stats, setStats] = useState({ total: 0, thisWeek: 0, lastUpdated: null as string | null });

    // UI state
    const [searchQuery, setSearchQuery] = useState('');
    const [sortBy, setSortBy] = useState<string>('date-desc');
    const [showDetailDialog, setShowDetailDialog] = useState(false);
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [templateToDelete, setTemplateToDelete] = useState<string | null>(null);

    const loadTemplates = useCallback(async () => {
        try {
            setLoading(true);
            const result = await patientInfoRepository.getAll(1, 999999);
            setTemplates(result.data);

            const statsData = await patientInfoRepository.getStats();
            setStats(statsData);
        } catch (error) {
            console.error('Failed to load templates:', error);
        } finally {
            setLoading(false);
        }
    }, []);

    const applyFiltersAndSort = useCallback(() => {
        let filtered = [...templates];

        // Filter by name (search)
        if (searchQuery.trim()) {
            const query = searchQuery.trim().toLowerCase();
            filtered = filtered.filter(t =>
                t.patientName.toLowerCase().includes(query) ||
                (t.diagnosis?.toLowerCase().includes(query)) ||
                (t.medicalHistory?.toLowerCase().includes(query))
            );
        }

        // Sorting (always applied)
        filtered.sort((a, b) => {
            const [sortField, sortDirection] = sortBy.split('-');
            let comparison = 0;

            switch (sortField) {
                case 'name':
                    comparison = a.patientName.localeCompare(b.patientName);
                    break;
                case 'date':
                    comparison = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
                    break;
                case 'age':
                    comparison = (parseInt(a.age) || 0) - (parseInt(b.age) || 0);
                    break;
            }

            return sortDirection === 'asc' ? comparison : -comparison;
        });

        setFilteredTemplates(filtered);
    }, [templates, searchQuery, sortBy]);

    useEffect(() => {
        loadTemplates();
        // Auto-refresh every 5 minutes
        const interval = setInterval(loadTemplates, 5 * 60 * 1000);
        return () => clearInterval(interval);
    }, [loadTemplates]);

    useEffect(() => {
        applyFiltersAndSort();
    }, [applyFiltersAndSort]);

    const handleDeleteTemplate = async () => {
        if (!templateToDelete) return;

        try {
            await patientInfoRepository.delete(templateToDelete);
            setTemplates(prev => prev.filter(t => t.id !== templateToDelete));
            setShowDeleteDialog(false);
            setTemplateToDelete(null);

            const statsData = await patientInfoRepository.getStats();
            setStats(statsData);
        } catch (error) {
            console.error('Failed to delete template:', error);
        }
    };

    const handleLoadTemplate = (template: PrescriptionTemplate) => {
        // Prefill the form with template data
        updateFormData({
            patient: {
                title: template.title || 'mr',
                patientName: template.patientName,
                age: template.age,
                gender: template.gender,
                weight: template.weight || '',
                allergies: '',
                diagnosis: template.diagnosis ? template.diagnosis.split(', ').filter(d => d.trim()) : [],
                patientComplaints: template.patientComplaints ? template.patientComplaints.split(', ').filter(c => c.trim()) : [],
                followUpDate: '',
                medicalHistory: template.medicalHistory ? template.medicalHistory.split(', ').filter(m => m.trim()) : [],
                drugHistory: template.drugHistory ? template.drugHistory.split(', ').filter(d => d.trim()) : [],
            },
            vitals: {
                bp: template.bloodPressure,
                pulse: template.pulse.toString(),
                temp: template.temperature.toString(),
                spo2: template.spo2.toString(),
            },
            medicines: template.medicines.map(med => ({
                id: Date.now().toString() + Math.random(),
                name: med.name,
                salt: med.salt || '',
                duration: {
                    days: parseInt(med.duration) || 0,
                    months: med.durationMonths || 0,
                    type: (med.durationType || 'days') as 'days' | 'months' | 'years'
                },
                remark: med.remark,
                timing: {
                    morning: parseInt(med.timing.split('-')[0]) || 0,
                    afternoon: parseInt(med.timing.split('-')[1]) || 0,
                    evening: parseInt(med.timing.split('-')[2]) || 0,
                    night: parseInt(med.timing.split('-')[3]) || 0,
                },
                foodTiming: (med.foodTiming || 'after') as 'before' | 'after',
                sos: med.sos || false,
                periodicity: med.frequency,
                startDate: new Date().toISOString().split('T')[0],
            })),
            tests: template.tests.map(test => ({
                id: Date.now().toString() + Math.random(),
                name: test.name,
                instructions: test.remark,
            })),
            remarks: template.remarks || '',
            nextReview: template.nextReview || '',
        });

        // Set the loaded template ID for future updates
        setLoadedTemplateId(template.id);

        // Navigate to main page
        router.push('/');
    };

    // const clearFilters = () => {
    //     setSearchQuery('');
    // };

    return (
        <div className="min-h-screen bg-gradient-to-br">
            <div className="container mx-auto p-6 space-y-8">
                {/* Header */}
                <div className="text-center space-y-4 animate-in fade-in slide-in-from-top-4 duration-700">
                    <div className="flex items-center justify-between gap-3 px-4 md:px-6">
                        <div className="text-left">
                            <h1 className="text-4xl font-bold bg-gradient-to-r from-green-800 to-green-400 bg-clip-text text-transparent">
                                Patient Templates
                            </h1>
                            <p className="text-gray-600 mt-2 text-lg">
                                Manage and reuse your prescription templates
                            </p>
                        </div>
                        <Button
                            onClick={loadTemplates}
                            variant="outline"
                            className="flex items-center gap-2 bg-white/80 backdrop-blur-sm hover:bg-white transition-all duration-300 hover:scale-105 shadow-lg"
                        >
                            <RefreshCw className="h-4 w-4" />
                            Refresh
                        </Button>
                    </div>
                </div>

                {/* Stats Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200">
                    <Card className="bg-gradient-to-r from-emerald-600 to-emerald-800 text-white shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105 border-0 group">
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                            <CardTitle className="text-sm font-medium text-emerald-100">Total Templates</CardTitle>
                            <FileText className="h-5 w-5 text-emerald-200 group-hover:scale-110 transition-transform duration-300" />
                        </CardHeader>
                        <CardContent>
                            <div className="text-3xl font-bold">{stats.total}</div>
                            <p className="text-xs text-emerald-200 mt-1">
                                {filteredTemplates.length !== stats.total ? `${filteredTemplates.length} filtered` : 'All templates'}
                            </p>
                        </CardContent>
                    </Card>

                    <Card className="bg-gradient-to-r from-green-600 to-emerald-800 text-white shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105 border-0 group">
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                            <CardTitle className="text-sm font-medium text-green-100">This Week</CardTitle>
                            <Activity className="h-5 w-5 text-green-200 group-hover:scale-110 transition-transform duration-300" />
                        </CardHeader>
                        <CardContent>
                            <div className="text-3xl font-bold">{stats.thisWeek}</div>
                            <p className="text-xs text-green-200 mt-1">New templates</p>
                        </CardContent>
                    </Card>

                    <Card className="bg-gradient-to-r from-purple-600 to-indigo-800 text-white shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105 border-0 group">
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                            <CardTitle className="text-sm font-medium text-purple-100">Last Updated</CardTitle>
                            <Clock className="h-5 w-5 text-purple-200 group-hover:scale-110 transition-transform duration-300" />
                        </CardHeader>
                        <CardContent>
                            <div className="text-lg font-bold">
                                {stats.lastUpdated ? formatDateShort(stats.lastUpdated) : 'No data'}
                            </div>
                            <p className="text-xs text-purple-200 mt-1">
                                {stats.lastUpdated ? formatDate(stats.lastUpdated) : ''}
                            </p>
                        </CardContent>
                    </Card>
                </div>

                {/* Search and Filters */}
                <Card className="bg-white/80 backdrop-blur-sm shadow-xl border-0 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-300">
                    <CardContent className="p-6">
                        <div className="flex flex-col md:flex-row gap-4">
                            {/* Search */}
                            <div className="relative flex-1">
                                <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
                                <Input
                                    placeholder="Search by patient name, diagnosis..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="pl-12 h-12 text-lg border-2 border-gray-200 focus:border-emerald-500 transition-colors duration-300 rounded-xl"
                                />
                            </div>

                            {/* Sort */}
                            <div className="flex gap-3 items-center">
                                <Select value={sortBy} onValueChange={setSortBy}>
                                    <SelectTrigger className="w-[220px] h-12 border-2 border-gray-200 focus:border-emerald-500 transition-colors duration-300 rounded-xl cursor-pointer">
                                        <SelectValue placeholder="Sort by..." />
                                    </SelectTrigger>
                                    <SelectContent className="bg-white shadow-xl border-0 rounded-xl">
                                        <SelectItem value="date-desc" className="rounded-lg">📅 Date: Newest First</SelectItem>
                                        <SelectItem value="date-asc" className="rounded-lg">� Date: Oldest First</SelectItem>
                                        <SelectItem value="name-asc" className="rounded-lg">👤 Name: A-Z</SelectItem>
                                        <SelectItem value="name-desc" className="rounded-lg">👤 Name: Z-A</SelectItem>
                                        <SelectItem value="age-asc" className="rounded-lg">🎂 Age: Low to High</SelectItem>
                                        <SelectItem value="age-desc" className="rounded-lg">🎂 Age: High to Low</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Templates Grid */}
                <div className="grid gap-6 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-500">
                    {loading ? (
                        <div className="flex items-center justify-center py-16">
                            <div className="flex flex-col items-center gap-4">
                                <div className="animate-spin rounded-full h-12 w-12 border-4 border-emerald-500 border-t-transparent"></div>
                                <p className="text-gray-600 animate-pulse">Loading templates...</p>
                            </div>
                        </div>
                    ) : filteredTemplates.length === 0 ? (
                        <Card className="bg-white/80 backdrop-blur-sm shadow-xl border-0 min-h-[400px] animate-in zoom-in-95 duration-300">
                            <CardContent className="flex items-center justify-center min-h-[400px]">
                                <div className="flex flex-col items-center gap-4 max-w-2xl mx-auto text-center">
                                    <div className="p-4 bg-gradient-to-r from-gray-100 to-gray-200 rounded-full">
                                        <FileText className="mx-auto h-12 w-12 text-gray-400" />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-semibold text-gray-700 mb-2">No templates found</h3>
                                        <p className="text-gray-500 max-w-md">
                                            {searchQuery ?
                                                'Try adjusting your search terms to find what you\'re looking for.' :
                                                'Start creating prescriptions to build your template library. Templates will appear here automatically after printing.'
                                            }
                                        </p>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    ) : (
                        filteredTemplates.map((template, index) => (
                            <Card
                                key={template.id}
                                className="bg-white/90 backdrop-blur-sm shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-[1.02] border-0 cursor-pointer group animate-in slide-in-from-bottom-4"
                                style={{ animationDelay: `${index * 100}ms` }}
                                onClick={() => {
                                    setSelectedTemplate(template);
                                    setShowDetailDialog(true);
                                }}
                            >
                                <CardHeader className="pb-4">
                                    <div className="flex items-start justify-between">
                                        <div className="flex-1">
                                            <CardTitle className="text-xl flex items-center gap-3 text-gray-800 group-hover:text-emerald-600 transition-colors duration-300">
                                                <div className="p-2 bg-gradient-to-r from-blue-500 to-indigo-600 rounded-lg group-hover:scale-110 transition-transform duration-300">
                                                    <User className="h-5 w-5 text-white" />
                                                </div>
                                                {template.patientName}
                                                {template.templateName && (
                                                    <Badge variant="secondary" className="bg-gradient-to-r from-purple-100 to-pink-100 text-purple-700 border-0">
                                                        <Sparkles className="h-3 w-3 mr-1" />
                                                        {template.templateName}
                                                    </Badge>
                                                )}
                                            </CardTitle>
                                            <div className="flex items-center gap-2 mt-3 text-sm text-gray-600 flex-wrap">
                                                <span className="flex items-center gap-2 bg-gray-100 px-3 py-1 rounded-full">
                                                    <Calendar className="h-4 w-4" />
                                                    {formatDateShort(template.timestamp)}
                                                </span>
                                                {template.title && (
                                                    <span className="flex items-center gap-1 bg-purple-100 px-3 py-1 rounded-full text-purple-700 capitalize">
                                                        {template.title}.
                                                    </span>
                                                )}
                                                <span className="flex items-center gap-2 bg-emerald-100 px-3 py-1 rounded-full text-emerald-700">
                                                    <User className="h-4 w-4" />
                                                    Age: {template.age || 'N/A'}
                                                </span>
                                                <span className="flex items-center gap-2 bg-green-100 px-3 py-1 rounded-full text-green-700 capitalize">
                                                    <Heart className="h-4 w-4" />
                                                    {template.gender || 'N/A'}
                                                </span>
                                                {template.weight && (
                                                    <span className="flex items-center gap-2 bg-orange-100 px-3 py-1 rounded-full text-orange-700">
                                                        <Activity className="h-4 w-4" />
                                                        {template.weight} kg
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setSelectedTemplate(template);
                                                    setShowDetailDialog(true);
                                                }}
                                                className="text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 transition-all duration-200 rounded-lg"
                                            >
                                                <Eye className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleLoadTemplate(template);
                                                }}
                                                className="text-green-600 hover:text-green-700 hover:bg-green-50 transition-all duration-200 rounded-lg"
                                            >
                                                <Download className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setTemplateToDelete(template.id);
                                                    setShowDeleteDialog(true);
                                                }}
                                                className="text-red-600 hover:text-red-700 hover:bg-red-50 transition-all duration-200 rounded-lg"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    <div className="space-y-4">
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            {template.patientComplaints && (
                                                <div>
                                                    <span className="font-semibold text-gray-700 flex items-center gap-2">
                                                        <FileText className="h-4 w-4 text-purple-500" />
                                                        Complaints:
                                                    </span>
                                                    <p className="text-gray-600 mt-1 line-clamp-2">{template.patientComplaints}</p>
                                                </div>
                                            )}

                                            <div>
                                                <span className="font-semibold text-gray-700 flex items-center gap-2">
                                                    <Heart className="h-4 w-4 text-red-500" />
                                                    Diagnosis:
                                                </span>
                                                <p className="text-gray-600 mt-1 line-clamp-2">{template.diagnosis || 'Not specified'}</p>
                                            </div>

                                            {template.medicalHistory && (
                                                <div>
                                                    <span className="font-semibold text-gray-700 flex items-center gap-2">
                                                        <FileText className="h-4 w-4 text-emerald-500" />
                                                        Medical History:
                                                    </span>
                                                    <p className="text-gray-600 mt-1 line-clamp-2">{template.medicalHistory}</p>
                                                </div>
                                            )}
                                        </div>

                                        {/* <div className="flex items-center gap-4 text-sm text-gray-600 bg-gray-50 p-3 rounded-lg">
                                            <span className="flex items-center gap-2">
                                                <Activity className="h-4 w-4 text-red-500" />
                                                BP: {template.bloodPressure || 'N/A'}
                                            </span>
                                            <span className="flex items-center gap-2">
                                                <Heart className="h-4 w-4 text-pink-500" />
                                                Pulse: {template.pulse || 'N/A'}
                                            </span>
                                            <span className="flex items-center gap-2">
                                                <TestTube className="h-4 w-4 text-emerald-500" />
                                                Temp: {template.temperature || 'N/A'}°F
                                            </span>
                                            <span className="flex items-center gap-2">
                                                <Activity className="h-4 w-4 text-green-500" />
                                                SpO₂: {template.spo2 || 'N/A'}%
                                            </span>
                                        </div> */}

                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-3">
                                                <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 flex items-center gap-1">
                                                    <Pill className="h-3 w-3" />
                                                    {template.medicines.length} medicines
                                                </Badge>
                                                <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 flex items-center gap-1">
                                                    <TestTube className="h-3 w-3" />
                                                    {template.tests.length} tests
                                                </Badge>
                                            </div>
                                            <div className="text-gray-400 group-hover:text-emerald-500 transition-colors duration-300">
                                                <ChevronRight className="h-5 w-5 group-hover:translate-x-1 transition-transform duration-300" />
                                            </div>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        ))
                    )}
                </div>

                {/* Detail Dialog */}
                <Dialog open={showDetailDialog} onOpenChange={setShowDetailDialog}>
                    <DialogContent className="w-[95vw] max-w-6xl h-[90vh] bg-white/95 backdrop-blur-sm border-0 shadow-2xl animate-in zoom-in-95 duration-300 rounded-lg flex flex-col p-0">
                        {/* Header - Stays fixed at the top */}
                        <DialogHeader className="p-6 pb-4 border-b">
                            <DialogTitle className="text-2xl flex flex-col sm:flex-row items-start sm:items-center gap-4 md:gap-8 text-gray-800 font-bold justify-between">
                                {/* Header with Patient Name */}
                                <div className="flex items-center gap-3">
                                    <div className='p-3 bg-gradient-to-r from-blue-500 to-indigo-600 rounded-xl shadow-lg flex items-center'>
                                        <User className="h-6 w-6 text-white" />
                                    </div>
                                    <span className="font-bold">{selectedTemplate?.patientName} - Details</span>
                                </div>

                                {/* Action Buttons */}
                                <div className="flex gap-4 items-center justify-end w-full sm:w-auto">
                                    <Button
                                        onClick={() => {
                                            handleLoadTemplate(selectedTemplate!);
                                            setShowDetailDialog(false);
                                        }}
                                        className="flex items-center gap-2 cursor-pointer bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white px-6 py-3 rounded-lg shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-103"
                                    >
                                        <SquareMousePointer className="h-5 w-5" />
                                        Use This Template
                                    </Button>
                                </div>
                            </DialogTitle>
                        </DialogHeader>

                        {/* Scrollable Content Area */}
                        {selectedTemplate && (
                            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                {/* Patient Info */}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <Card className="bg-gradient-to-r from-emerald-50 to-green-50 border-0 shadow-lg rounded-lg">
                                        <CardHeader className="pb-4">
                                            <CardTitle className="text-lg flex items-center gap-2 text-emerald-800">
                                                <User className="h-5 w-5" />
                                                Patient Information
                                            </CardTitle>
                                        </CardHeader>
                                        <CardContent className="space-y-3 text-sm">
                                            <div className="flex justify-between items-center p-3 bg-white rounded-xl shadow-sm">
                                                <strong className="text-gray-600">Title:</strong>
                                                <span className="text-gray-800 font-medium capitalize">{selectedTemplate.title || 'N/A'}</span>
                                            </div>
                                            <div className="flex justify-between items-center p-3 bg-white rounded-xl shadow-sm">
                                                <strong className="text-gray-600">Name:</strong>
                                                <span className="text-gray-800 font-medium">{selectedTemplate.patientName}</span>
                                            </div>
                                            <div className="flex justify-between items-center p-3 bg-white rounded-xl shadow-sm">
                                                <strong className="text-gray-600">Age:</strong>
                                                <span className="text-gray-800 font-medium">{selectedTemplate.age || 'N/A'}</span>
                                            </div>
                                            <div className="flex justify-between items-center p-3 bg-white rounded-xl shadow-sm">
                                                <strong className="text-gray-600">Gender:</strong>
                                                <span className="text-gray-800 font-medium capitalize">{selectedTemplate.gender || 'N/A'}</span>
                                            </div>
                                            {selectedTemplate.weight && (
                                                <div className="flex justify-between items-center p-3 bg-white rounded-xl shadow-sm">
                                                    <strong className="text-gray-600">Weight:</strong>
                                                    <span className="text-gray-800 font-medium">{selectedTemplate.weight} kg</span>
                                                </div>
                                            )}
                                            <div className="flex justify-between items-center p-3 bg-white rounded-xl shadow-sm">
                                                <strong className="text-gray-600">Created:</strong>
                                                <span className="text-gray-800 font-medium">{formatDate(selectedTemplate.timestamp)}</span>
                                            </div>
                                        </CardContent>
                                    </Card>

                                    <Card className="bg-gradient-to-r from-green-50 to-emerald-50 border-0 shadow-lg rounded-lg">
                                        <CardHeader className="pb-4">
                                            <CardTitle className="text-lg flex items-center gap-2 text-green-800">
                                                <Activity className="h-5 w-5" />
                                                Vital Signs
                                            </CardTitle>
                                        </CardHeader>
                                        <CardContent className="space-y-3 text-sm">
                                            <div className="flex justify-between items-center p-3 bg-white rounded-xl shadow-sm">
                                                <strong className="text-gray-600">Blood Pressure:</strong>
                                                <span className="text-gray-800 font-medium">{selectedTemplate.bloodPressure || 'N/A'}</span>
                                            </div>
                                            <div className="flex justify-between items-center p-3 bg-white rounded-xl shadow-sm">
                                                <strong className="text-gray-600">Pulse:</strong>
                                                <span className="text-gray-800 font-medium">{selectedTemplate.pulse || 'N/A'} /min</span>
                                            </div>
                                            <div className="flex justify-between items-center p-3 bg-white rounded-xl shadow-sm">
                                                <strong className="text-gray-600">Temperature:</strong>
                                                <span className="text-gray-800 font-medium">{selectedTemplate.temperature || 'N/A'}°F</span>
                                            </div>
                                            <div className="flex justify-between items-center p-3 bg-white rounded-xl shadow-sm">
                                                <strong className="text-gray-600">SpO₂:</strong>
                                                <span className="text-gray-800 font-medium">{selectedTemplate.spo2 || 'N/A'}%</span>
                                            </div>
                                        </CardContent>
                                    </Card>
                                </div>

                                {/* Medical Info */}
                                <div className="space-y-6">
                                    <Card className="bg-gradient-to-r from-purple-50 to-pink-50 border-0 shadow-lg rounded-lg">
                                        <CardHeader className="pb-4">
                                            <CardTitle className="text-lg flex items-center gap-2 text-purple-800">
                                                <Heart className="h-5 w-5" />
                                                Medical Information
                                            </CardTitle>
                                        </CardHeader>
                                        <CardContent className="space-y-4 text-sm">
                                            {selectedTemplate.patientComplaints && (
                                                <div className="p-4 bg-white rounded-xl shadow-sm">
                                                    <strong className="text-gray-600 block mb-2">Patient Complaints:</strong>
                                                    <p className="text-gray-800 leading-relaxed">{selectedTemplate.patientComplaints}</p>
                                                </div>
                                            )}
                                            <div className="p-4 bg-white rounded-xl shadow-sm">
                                                <strong className="text-gray-600 block mb-2">Diagnosis:</strong>
                                                <p className="text-gray-800 leading-relaxed">{selectedTemplate.diagnosis || 'Not specified'}</p>
                                            </div>
                                            {selectedTemplate.medicalHistory && (
                                                <div className="p-4 bg-white rounded-xl shadow-sm">
                                                    <strong className="text-gray-600 block mb-2">Medical History:</strong>
                                                    <p className="text-gray-800 leading-relaxed">{selectedTemplate.medicalHistory}</p>
                                                </div>
                                            )}
                                        </CardContent>
                                    </Card>
                                </div>

                                {/* Medicines */}
                                {selectedTemplate.medicines.length > 0 && (
                                    <Card className="bg-gradient-to-r from-emerald-50 to-green-50 border-0 shadow-lg rounded-lg">
                                        <CardHeader className="pb-4">
                                            <CardTitle className="text-lg flex items-center gap-2 text-emerald-800">
                                                <Pill className="h-5 w-5" />
                                                Medicines ({selectedTemplate.medicines.length})
                                            </CardTitle>
                                        </CardHeader>
                                        <CardContent>
                                            <div className="grid gap-4">
                                                {selectedTemplate.medicines.map((medicine, index) => (
                                                    <div key={index} className="p-4 bg-white rounded-lg shadow-sm border border-emerald-100 hover:shadow-md transition-shadow duration-300">
                                                        <div className="flex items-start justify-between mb-3">
                                                            <div className="flex-1">
                                                                <div className="font-bold text-gray-900 mb-1 flex items-center gap-2">
                                                                    <Pill className="h-5 w-5 text-emerald-500" />
                                                                    {medicine.name}
                                                                    {medicine.sos && (
                                                                        <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 text-xs">
                                                                            SOS
                                                                        </Badge>
                                                                    )}
                                                                </div>
                                                                {medicine.salt && (
                                                                    <div className="text-xs text-gray-500 mb-2 italic">
                                                                        {medicine.salt}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>

                                                        <div className="grid grid-cols-2 gap-3 text-sm">
                                                            <div className="p-2 bg-emerald-50 rounded-lg">
                                                                <div className="text-gray-600 text-xs font-medium mb-1">Dosage</div>
                                                                <div className="text-gray-800 font-semibold">{medicine.dosage}</div>
                                                            </div>
                                                            <div className="p-2 bg-green-50 rounded-lg">
                                                                <div className="text-gray-600 text-xs font-medium mb-1">Frequency</div>
                                                                <div className="text-gray-800 font-semibold capitalize">{medicine.frequency}</div>
                                                            </div>
                                                            <div className="p-2 bg-purple-50 rounded-lg">
                                                                <div className="text-gray-600 text-xs font-medium mb-1">Duration</div>
                                                                <div className="text-gray-800 font-semibold">
                                                                    {medicine.duration} {medicine.durationType || 'days'}
                                                                    {medicine.durationMonths && medicine.durationMonths > 0 ? ` (${medicine.durationMonths} months)` : ''}
                                                                </div>
                                                            </div>
                                                            <div className="p-2 bg-orange-50 rounded-lg">
                                                                <div className="text-gray-600 text-xs font-medium mb-1">Food Timing</div>
                                                                <div className="text-gray-800 font-semibold capitalize">{medicine.foodTiming || 'after'}</div>
                                                            </div>
                                                        </div>

                                                        {medicine.remark && (
                                                            <div className="text-xs text-gray-600 mt-3 p-3 bg-yellow-50 rounded-lg border border-yellow-200">
                                                                <span className="font-semibold">💡 Note:</span> {medicine.remark}
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </CardContent>
                                    </Card>
                                )}

                                {/* Tests */}
                                {selectedTemplate.tests.length > 0 && (
                                    <Card className="bg-gradient-to-r from-orange-50 to-red-50 border-0 shadow-lg rounded-lg">
                                        <CardHeader className="pb-4">
                                            <CardTitle className="text-lg flex items-center gap-2 text-orange-800">
                                                <TestTube className="h-5 w-5" />
                                                Tests ({selectedTemplate.tests.length})
                                            </CardTitle>
                                        </CardHeader>
                                        <CardContent>
                                            <div className="grid gap-4">
                                                {selectedTemplate.tests.map((test, index) => (
                                                    <div key={index} className="p-4 bg-white rounded-lg shadow-sm border border-orange-100 hover:shadow-md transition-shadow duration-300">
                                                        <div className="flex items-center gap-3">
                                                            <TestTube className="h-5 w-5 text-orange-500" />
                                                            <div className="font-semibold text-gray-800">{test.name}</div>
                                                        </div>
                                                        {test.remark && (
                                                            <div className="text-sm text-gray-600 mt-2 ml-8">
                                                                📋 {test.remark}
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </CardContent>
                                    </Card>
                                )}

                                {/* Additional Information */}
                                {(selectedTemplate.remarks || selectedTemplate.nextReview) && (
                                    <Card className="bg-gradient-to-r from-indigo-50 to-blue-50 border-0 shadow-lg rounded-lg">
                                        <CardHeader className="pb-4">
                                            <CardTitle className="text-lg flex items-center gap-2 text-indigo-800">
                                                <FileText className="h-5 w-5" />
                                                Additional Information
                                            </CardTitle>
                                        </CardHeader>
                                        <CardContent className="space-y-4 text-sm">
                                            {selectedTemplate.remarks && (
                                                <div className="p-4 bg-white rounded-xl shadow-sm">
                                                    <strong className="text-gray-600 mb-2 flex items-center gap-2">
                                                        <FileText className="h-4 w-4" />
                                                        Remarks:
                                                    </strong>
                                                    <p className="text-gray-800 leading-relaxed">{selectedTemplate.remarks}</p>
                                                </div>
                                            )}
                                            {selectedTemplate.nextReview && (
                                                <div className="p-4 bg-white rounded-xl shadow-sm">
                                                    <strong className="text-gray-600 mb-2 flex items-center gap-2">
                                                        <Calendar className="h-4 w-4" />
                                                        Next Review:
                                                    </strong>
                                                    <p className="text-gray-800 leading-relaxed font-medium">{selectedTemplate.nextReview}</p>
                                                </div>
                                            )}
                                        </CardContent>
                                    </Card>
                                )}
                            </div>
                        )}
                    </DialogContent>
                </Dialog>

                {/* Delete Confirmation Dialog */}
                <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Delete Template</AlertDialogTitle>
                            <AlertDialogDescription>
                                Are you sure you want to delete this prescription template? This action cannot be undone.
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                                onClick={handleDeleteTemplate}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                                Delete
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </div>
        </div>
    );
}