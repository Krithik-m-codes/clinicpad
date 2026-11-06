"use client";

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Search, Clock, User, Trash2, FileText } from 'lucide-react';
import { patientInfoRepository, type PatientInfoTemplate } from '@/lib/db';
import { formatDate } from '@/lib/utils';

type PrescriptionTemplate = PatientInfoTemplate;

interface TemplateViewerProps {
    onSelectTemplate: (template: PrescriptionTemplate) => void;
    isOpen: boolean;
    onClose: () => void;
}

export default function TemplateViewer({ onSelectTemplate, isOpen, onClose }: TemplateViewerProps) {
    const [templates, setTemplates] = useState<PrescriptionTemplate[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [loading, setLoading] = useState(true);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [templateToDelete, setTemplateToDelete] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen) {
            loadTemplates();
        }
    }, [isOpen]);

    const loadTemplates = async () => {
        try {
            setLoading(true);
            const result = await patientInfoRepository.getAll(1, 999999);
            setTemplates(result.data);
        } catch (error) {
            console.error('Failed to load templates:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleSearch = async (query: string) => {
        setSearchQuery(query);
        if (query.trim()) {
            try {
                const result = await patientInfoRepository.search(query, 1, 999999);
                setTemplates(result.data);
            } catch (error) {
                console.error('Search failed:', error);
            }
        } else {
            loadTemplates();
        }
    };

    const handleDeleteTemplate = async () => {
        if (!templateToDelete) return;

        try {
            await patientInfoRepository.delete(templateToDelete);
            setTemplates(prev => prev.filter(t => t.id !== templateToDelete));
            setDeleteDialogOpen(false);
            setTemplateToDelete(null);
        } catch (error) {
            console.error('Failed to delete template:', error);
        }
    };


    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-background rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
                <div className="p-6 border-b">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-2xl font-bold">Prescription Templates</h2>
                        <Button variant="outline" onClick={onClose}>Close</Button>
                    </div>

                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
                        <Input
                            placeholder="Search templates by patient name, diagnosis, or template name..."
                            value={searchQuery}
                            onChange={(e) => handleSearch(e.target.value)}
                            className="pl-10"
                        />
                    </div>
                </div>

                <div className="p-6 overflow-y-auto max-h-[60vh]">
                    {loading ? (
                        <div className="flex items-center justify-center py-8">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                        </div>
                    ) : templates.length === 0 ? (
                        <div className="text-center py-8">
                            <FileText className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
                            <p className="text-lg font-medium">No templates found</p>
                            <p className="text-muted-foreground">
                                {searchQuery ? 'Try adjusting your search terms' : 'Start creating prescriptions to build your template library'}
                            </p>
                        </div>
                    ) : (
                        <div className="grid gap-4">
                            {templates.map((template) => (
                                <Card key={template.id} className="hover:shadow-md transition-all duration-200 hover:scale-[1.02]">
                                    <CardHeader className="pb-3">
                                        <div className="flex items-start justify-between">
                                            <div className="flex-1">
                                                <CardTitle className="text-lg flex items-center gap-2">
                                                    <User className="h-4 w-4" />
                                                    {template.patientName}
                                                    {template.templateName && (
                                                        <Badge variant="secondary" className="ml-2">
                                                            {template.templateName}
                                                        </Badge>
                                                    )}
                                                </CardTitle>
                                                <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                                                    <span className="flex items-center gap-1">
                                                        <Clock className="h-3 w-3" />
                                                        {formatDate(template.timestamp)}
                                                    </span>
                                                    <span>Age: {template.age || 'N/A'}</span>
                                                    <span>Gender: {template.gender || 'N/A'}</span>
                                                </div>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => {
                                                    setTemplateToDelete(template.id);
                                                    setDeleteDialogOpen(true);
                                                }}
                                                className="text-destructive hover:text-destructive"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </CardHeader>
                                    <CardContent className="pt-0">
                                        <div className="space-y-2">
                                            <div>
                                                <span className="font-medium text-sm">Diagnosis: </span>
                                                <span className="text-sm">{template.diagnosis || 'Not specified'}</span>
                                            </div>

                                            {template.medicalHistory && (
                                                <div>
                                                    <span className="font-medium text-sm">Medical History: </span>
                                                    <span className="text-sm">{template.medicalHistory}</span>
                                                </div>
                                            )}

                                            <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                                <span>BP: {template.bloodPressure || 'N/A'}</span>
                                                <span>Pulse: {template.pulse || 'N/A'}</span>
                                                <span>Temp: {template.temperature || 'N/A'}°F</span>
                                                <span>SpO₂: {template.spo2 || 'N/A'}%</span>
                                            </div>

                                            <div className="flex items-center gap-2 mt-3">
                                                <Badge variant="outline" className="text-xs">
                                                    {template.medicines.length} medicines
                                                </Badge>
                                                <Badge variant="outline" className="text-xs">
                                                    {template.tests.length} tests
                                                </Badge>
                                            </div>
                                        </div>

                                        <div className="mt-4">
                                            <Button
                                                onClick={() => {
                                                    onSelectTemplate(template);
                                                    onClose();
                                                }}
                                                className="w-full"
                                            >
                                                Use This Template
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
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
    );
}