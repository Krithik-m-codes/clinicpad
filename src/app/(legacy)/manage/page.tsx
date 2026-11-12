"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Papa, { type ParseResult } from "papaparse";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
    patientInfoRepository,
    medicinesRepository,
    complaintsRepository,
    diagnosisRepository,
    medicalHistoryRepository,
    testsRepository
} from "@/lib/db";
import {
    Database,
    Pill,
    FileText,
    Stethoscope,
    ClipboardList,
    Upload,
    Search,
    Edit,
    Trash2,
    Plus,
    ArrowLeft,
    RefreshCw,
} from "lucide-react";

type DataType = "medicines" | "complaints" | "diagnosis" | "medicalHistory" | "tests";

interface Stats {
    medicines: number;
    complaints: number;
    diagnosis: number;
    medicalHistory: number;
    tests: number;
    patientInfo: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DataRecord = any;

export default function ManageDataPage() {
    const { toast } = useToast();

    // Navigation state
    const [currentView, setCurrentView] = useState<"menu" | "manage">("menu");
    const [selectedDataType, setSelectedDataType] = useState<DataType | null>(null);

    // Stats
    const [stats, setStats] = useState<Stats>({
        medicines: 0,
        complaints: 0,
        diagnosis: 0,
        medicalHistory: 0,
        tests: 0,
        patientInfo: 0,
    });

    // Data state
    const [data, setData] = useState<DataRecord[]>([]);
    const [sortBy, setSortBy] = useState<string | null>(null);
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
    const [currentPage, setCurrentPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [searchQuery, setSearchQuery] = useState("");
    const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
    const [isLoading, setIsLoading] = useState(false);

    // Dialog states
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [showEditDialog, setShowEditDialog] = useState(false);
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [showUploadDialog, setShowUploadDialog] = useState(false);
    const [selectedItem, setSelectedItem] = useState<DataRecord | null>(null);

    // Form state
    const [formData, setFormData] = useState<DataRecord>({});

    // Upload state
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [isUploading, setIsUploading] = useState(false);

    const loadStats = useCallback(async () => {
        try {
            const [medicinesCount, complaintsCount, diagnosisCount, medicalHistoryCount, testsCount, patientInfoCount] =
                await Promise.all([
                    medicinesRepository.count(),
                    complaintsRepository.count(),
                    diagnosisRepository.count(),
                    medicalHistoryRepository.count(),
                    testsRepository.count(),
                    patientInfoRepository.count(),
                ]);

            setStats({
                medicines: medicinesCount,
                complaints: complaintsCount,
                diagnosis: diagnosisCount,
                medicalHistory: medicalHistoryCount,
                tests: testsCount,
                patientInfo: patientInfoCount,
            });
        } catch (error) {
            console.error("Error loading stats:", error);
            toast({
                title: "Error",
                description: "Failed to load statistics",
                variant: "destructive",
            });
        }
    }, [toast]);

    const loadData = useCallback(async () => {
        if (!selectedDataType) return;

        setIsLoading(true);
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let result: any;

            switch (selectedDataType) {
                case "medicines":
                    result = debouncedSearchQuery
                        ? await medicinesRepository.search(debouncedSearchQuery, currentPage, 50)
                        : await medicinesRepository.getAll(currentPage, 50);
                    break;
                case "complaints":
                    result = debouncedSearchQuery
                        ? await complaintsRepository.search(debouncedSearchQuery, currentPage, 50)
                        : await complaintsRepository.getAll(currentPage, 50);
                    break;
                case "diagnosis":
                    result = debouncedSearchQuery
                        ? await diagnosisRepository.search(debouncedSearchQuery, currentPage, 50)
                        : await diagnosisRepository.getAll(currentPage, 50);
                    break;
                case "medicalHistory":
                    result = debouncedSearchQuery
                        ? await medicalHistoryRepository.search(debouncedSearchQuery, currentPage, 50)
                        : await medicalHistoryRepository.getAll(currentPage, 50);
                    break;
                case "tests": {
                    result = debouncedSearchQuery
                        ? await testsRepository.searchByName(debouncedSearchQuery, currentPage , 50)
                        : await testsRepository.getAll(currentPage, 50);
                    break;
                }
                default:
                    result = { data: [], total: 0, page: 1, limit: 50, totalPages: 1 };
            }

            setData(result.data as DataRecord[]);
            setTotalPages(result.totalPages);
        } catch (error) {
            console.error("Error loading data:", error);
            toast({
                title: "Error",
                description: "Failed to load data",
                variant: "destructive",
            });
        } finally {
            setIsLoading(false);
        }
    }, [selectedDataType, currentPage, debouncedSearchQuery, toast]);

    // Apply client-side sorting to data for display
    const sortedData = (() => {
        if (!sortBy) return data;
        const copy = [...data];
        copy.sort((a, b) => {
            const va = a[sortBy];
            const vb = b[sortBy];

            if (va == null && vb == null) return 0;
            if (va == null) return sortDir === 'asc' ? -1 : 1;
            if (vb == null) return sortDir === 'asc' ? 1 : -1;

            if (typeof va === 'number' && typeof vb === 'number') {
                return sortDir === 'asc' ? va - vb : vb - va;
            }

            const sa = String(va).toLowerCase();
            const sb = String(vb).toLowerCase();
            if (sa < sb) return sortDir === 'asc' ? -1 : 1;
            if (sa > sb) return sortDir === 'asc' ? 1 : -1;
            return 0;
        });
        return copy;
    })();

    // Load stats on mount
    useEffect(() => {
        loadStats();
    }, [loadStats]);

    // Add ref to skip initial mount for page reset
    const isInitialPageReset = useRef(true);

    // <--  Add useEffect to debounce the search query
    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedSearchQuery(searchQuery);
        }, 500); // 500ms delay

        // Cleanup function to cancel the timeout if user types again
        return () => {
            clearTimeout(handler);
        };
    }, [searchQuery]); // Only re-run if searchQuery (the live value) changes

    // <-- Add useEffect to reset page when the *debounced* search changes
    useEffect(() => {
        // Skip the very first run on mount
        if (isInitialPageReset.current) {
            isInitialPageReset.current = false;

            return;
        }

        // Reset to page 1 whenever the committed search query changes
        setCurrentPage(1);
    }, [debouncedSearchQuery]);

    // Load data when data type, view, or data-loading function changes
    useEffect(() => {
        if (selectedDataType && currentView === "manage") {
            loadData();
        }
        // This hook 'loadData' changes when its dependencies
        // (currentPage, debouncedSearchQuery) change, triggering a reload.
    }, [selectedDataType, currentView, loadData]);

    const handleSelectDataType = (type: DataType) => {
        setSelectedDataType(type);
        setCurrentView("manage");
        setCurrentPage(1);
        setSearchQuery("");
    };

    const handleBack = () => {
        setCurrentView("menu");
        setSelectedDataType(null);
        setData([]);
        setSearchQuery("");
        setDebouncedSearchQuery("");
    };

    const handleDelete = async () => {
        if (!selectedItem || !selectedDataType) return;

        try {
            let success = false;

            switch (selectedDataType) {
                case "medicines":
                    success = await medicinesRepository.delete(selectedItem.id);
                    break;
                case "complaints":
                    success = await complaintsRepository.delete(selectedItem.id);
                    break;
                case "diagnosis":
                    success = await diagnosisRepository.delete(selectedItem.id);
                    break;
                case "medicalHistory":
                    success = await medicalHistoryRepository.delete(selectedItem.id);
                    break;
                case "tests": {
                    success = await testsRepository.delete(selectedItem.id);
                    break;
                }

            }

            if (success) {
                toast({
                    title: "Success",
                    description: "Record deleted successfully",
                });
                loadData();
                loadStats();
            }
        } catch (error) {
            console.error("Error deleting:", error);
            toast({
                title: "Error",
                description: "Failed to delete record",
                variant: "destructive",
            });
        } finally {
            setShowDeleteDialog(false);
            setSelectedItem(null);
        }
    };

    const handleEdit = async () => {
        if (!selectedItem || !selectedDataType) return;

        try {
            let success = false;

            switch (selectedDataType) {
                case "medicines":
                    success = await medicinesRepository.update(selectedItem.id, formData);
                    break;
                case "complaints":
                    success = await complaintsRepository.update(selectedItem.id, formData);
                    break;
                case "diagnosis":
                    success = await diagnosisRepository.update(selectedItem.id, formData);
                    break;
                case "medicalHistory":
                    success = await medicalHistoryRepository.update(selectedItem.id, formData);
                    break;
                case "tests": {
                    success = await testsRepository.update(selectedItem.id, formData);
                    break;
                }
            }

            if (success) {
                toast({
                    title: "Success",
                    description: "Record updated successfully",
                });
                loadData();
            }
        } catch (error) {
            console.error("Error updating:", error);
            toast({
                title: "Error",
                description: "Failed to update record",
                variant: "destructive",
            });
        } finally {
            setShowEditDialog(false);
            setSelectedItem(null);
            setFormData({});
        }
    };

    const handleCreate = async () => {
        if (!selectedDataType) return;

        try {
            switch (selectedDataType) {
                case "medicines":
                    await medicinesRepository.create(formData);
                    break;
                case "complaints":
                    await complaintsRepository.create(formData);
                    break;
                case "diagnosis":
                    await diagnosisRepository.create(formData);
                    break;
                case "medicalHistory":
                    await medicalHistoryRepository.create(formData);
                    break;
                case "tests": {
                    await testsRepository.create(formData);
                    break;
                }
            }

            toast({
                title: "Success",
                description: "Record created successfully",
            });
            loadData();
            loadStats();
        } catch (error) {
            console.error("Error creating:", error);
            toast({
                title: "Error",
                description: "Failed to create record",
                variant: "destructive",
            });
        } finally {
            setShowCreateDialog(false);
            setFormData({});
        }
    };

    const handleUpload = async () => {
        if (!uploadFile || !selectedDataType) return;

        setIsUploading(true);
        setUploadProgress(0);

        try {
            // Use PapaParse for robust CSV parsing
            const text = await uploadFile.text();

            // Parse CSV with PapaParse
            const parseResult = await new Promise<ParseResult<Record<string, string>>>((resolve, reject) => {
                Papa.parse(text, {
                    header: true,
                    skipEmptyLines: true,
                    transformHeader: (header: string) => header.trim(),
                    transform: (value: string) => value.trim(),
                    complete: (results: ParseResult<Record<string, string>>) => resolve(results),
                    error: (error: Error) => reject(error),
                });
            });

            if (parseResult.errors.length > 0) {
                console.warn("CSV parsing warnings:", parseResult.errors);
            }

            const records = parseResult.data;

            if (records.length === 0) {
                toast({
                    title: "Error",
                    description: "CSV file is empty or has no valid data",
                    variant: "destructive",
                });
                return;
            }

            // Track overall statistics
            let totalInserted = 0;
            let totalSkipped = 0;
            const allDuplicates: string[] = [];

            // Process in chunks
            const chunkSize = 100;
            for (let i = 0; i < records.length; i += chunkSize) {
                const chunk = records.slice(i, i + chunkSize);
                let result: { inserted: number; skipped: number; duplicates: string[] };

                switch (selectedDataType) {
                    case "medicines":
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        result = await medicinesRepository.bulkCreate(chunk as any, chunkSize);
                        break;
                    case "complaints":
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        result = await complaintsRepository.bulkCreate(chunk as any, chunkSize);
                        break;
                    case "diagnosis":
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        result = await diagnosisRepository.bulkCreate(chunk as any, chunkSize);
                        break;
                    case "medicalHistory":
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        result = await medicalHistoryRepository.bulkCreate(chunk as any, chunkSize);
                        break;
                    case "tests": {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        result = await testsRepository.bulkCreate(chunk as any, chunkSize);
                        break;
                    }
                    default:
                        result = { inserted: 0, skipped: 0, duplicates: [] };
                }

                totalInserted += result.inserted;
                totalSkipped += result.skipped;
                allDuplicates.push(...result.duplicates);

                setUploadProgress(Math.round(((i + chunk.length) / records.length) * 100));
            }

            // Display comprehensive results
            if (totalSkipped > 0) {
                toast({
                    title: "Upload Complete with Duplicates",
                    description: `${totalInserted} records inserted, ${totalSkipped} duplicates skipped. ${allDuplicates.length > 0 ? `Duplicates: ${allDuplicates.slice(0, 5).join(", ")}${allDuplicates.length > 5 ? "..." : ""}` : ""}`,
                    variant: "default",
                });
            } else {
                toast({
                    title: "Success",
                    description: `Uploaded ${totalInserted} records successfully`,
                });
            }

            loadData();
            loadStats();
        } catch (error) {
            console.error("Error uploading:", error);
            toast({
                title: "Error",
                description: "Failed to upload CSV file",
                variant: "destructive",
            });
        } finally {
            setIsUploading(false);
            setUploadProgress(0);
            setShowUploadDialog(false);
            setUploadFile(null);
        }
    };

    const openEditDialog = (item: DataRecord) => {
        setSelectedItem(item);
        setFormData({ ...item });
        setShowEditDialog(true);
    };

    const openDeleteDialog = (item: DataRecord) => {
        setSelectedItem(item);
        setShowDeleteDialog(true);
    };

    const openCreateDialog = () => {
        setFormData({});
        setShowCreateDialog(true);
    };

    const openUploadDialog = () => {
        setUploadFile(null);
        setShowUploadDialog(true);
    };

    const getDataTypeLabel = (type: DataType) => {
        const labels = {
            medicines: "Medicines",
            complaints: "Complaints",
            diagnosis: "Diagnosis",
            medicalHistory: "Medical History",
            tests: "Tests",
            patientInfo: "Patient Records",
        };
        return labels[type];
    };

    const getDataTypeIcon = (type: DataType) => {
        const icons = {
            medicines: Pill,
            complaints: FileText,
            diagnosis: Stethoscope,
            medicalHistory: ClipboardList,
            tests: Database,
            patientInfo: Database,
        };
        return icons[type];
    };

    const renderFormFields = () => {
        if (!selectedDataType) return null;

        switch (selectedDataType) {
            case "medicines":
                return (
                    <>
                        <div className="space-y-2">
                            <Label htmlFor="name">Name *</Label>
                            <Input
                                id="name"
                                value={formData.name || ""}
                                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                placeholder="Enter medicine name"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="salt">Salt/Composition *</Label>
                            <Input
                                id="salt"
                                value={formData.salt || ""}
                                onChange={(e) => setFormData({ ...formData, salt: e.target.value })}
                                placeholder="Enter salt/composition"
                            />
                        </div>
                    </>
                );

            case "diagnosis":
                return (
                    <>
                        <div className="space-y-2">
                            <Label htmlFor="name">Name *</Label>
                            <Input
                                id="name"
                                value={formData.name || ""}
                                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                placeholder="Enter diagnosis name"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="icdCode">ICD Code *</Label>
                            <Input
                                id="icdCode"
                                value={formData.icdCode || ""}
                                onChange={(e) => setFormData({ ...formData, icdCode: e.target.value })}
                                placeholder="Enter ICD-10 code"
                            />
                        </div>
                    </>
                );

            default:
                return (
                    <div className="space-y-2">
                        <Label htmlFor="name">Name *</Label>
                        <Input
                            id="name"
                            value={formData.name || ""}
                            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                            placeholder="Enter name"
                        />
                    </div>
                );
        }
    };

    const renderTableHeaders = () => {
        if (!selectedDataType) return null;

        const toggleSort = (key: string) => {
            if (sortBy === key) {
                setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
            } else {
                setSortBy(key);
                setSortDir('asc');
            }
        };

        switch (selectedDataType) {
            case "medicines":
                return (
                    <>
                        <TableHead>
                            <button className="flex items-center gap-2" onClick={() => toggleSort('id')}>
                                ID {sortBy === 'id' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                            </button>
                        </TableHead>
                        <TableHead>
                            <button className="flex items-center gap-2" onClick={() => toggleSort('name')}>
                                Name {sortBy === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                            </button>
                        </TableHead>
                        <TableHead>
                            <button className="flex items-center gap-2" onClick={() => toggleSort('salt')}>
                                Salt/Composition {sortBy === 'salt' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                            </button>
                        </TableHead>
                        <TableHead>Actions</TableHead>
                    </>
                );
            case "diagnosis":
                return (
                    <>
                        <TableHead>
                            <button className="flex items-center gap-2" onClick={() => toggleSort('id')}>
                                ID {sortBy === 'id' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                            </button>
                        </TableHead>
                        <TableHead>
                            <button className="flex items-center gap-2" onClick={() => toggleSort('name')}>
                                Name {sortBy === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                            </button>
                        </TableHead>
                        <TableHead>
                            <button className="flex items-center gap-2" onClick={() => toggleSort('icdCode')}>
                                ICD Code {sortBy === 'icdCode' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                            </button>
                        </TableHead>
                        <TableHead>Actions</TableHead>
                    </>
                );
            default:
                return (
                    <>
                        <TableHead>
                            <button className="flex items-center gap-2" onClick={() => toggleSort('id')}>
                                ID {sortBy === 'id' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                            </button>
                        </TableHead>
                        <TableHead>
                            <button className="flex items-center gap-2" onClick={() => toggleSort('name')}>
                                Name {sortBy === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                            </button>
                        </TableHead>
                        <TableHead>Actions</TableHead>
                    </>
                );
        }
    };

    const renderTableRow = (item: DataRecord) => {
        if (!selectedDataType) return null;

        switch (selectedDataType) {
            case "medicines":
                return (
                    <>
                        <TableCell className="font-medium">{item.id}</TableCell>
                        <TableCell>{item.name}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">{item.salt || "-"}</TableCell>
                        <TableCell>
                            <div className="flex gap-2">
                                <Button size="sm" variant="outline" onClick={() => openEditDialog(item)}>
                                    <Edit className="h-4 w-4" />
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => openDeleteDialog(item)}
                                    className="text-red-600 hover:text-red-700"
                                >
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            </div>
                        </TableCell>
                    </>
                );
            case "diagnosis":
                return (
                    <>
                        <TableCell className="font-medium">{item.id}</TableCell>
                        <TableCell>{item.name}</TableCell>
                        <TableCell>{item.icdCode || "-"}</TableCell>
                        <TableCell>
                            <div className="flex gap-2">
                                <Button size="sm" variant="outline" onClick={() => openEditDialog(item)}>
                                    <Edit className="h-4 w-4" />
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => openDeleteDialog(item)}
                                    className="text-red-600 hover:text-red-700"
                                >
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            </div>
                        </TableCell>
                    </>
                );
            default:
                return (
                    <>
                        <TableCell className="font-medium">{item.id}</TableCell>
                        <TableCell>{item.name}</TableCell>
                        <TableCell>
                            <div className="flex gap-2">
                                <Button size="sm" variant="outline" onClick={() => openEditDialog(item)}>
                                    <Edit className="h-4 w-4" />
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => openDeleteDialog(item)}
                                    className="text-red-600 hover:text-red-700"
                                >
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            </div>
                        </TableCell>
                    </>
                );
        }
    };

    if (currentView === "menu") {
        return (
            <div className="container mx-auto p-6 max-w-7xl min-h-screen">
                <div className="mb-8">
                    <h1 className="text-3xl font-bold mb-2">Manage Data</h1>
                    <p className="text-muted-foreground">
                        Manage your medical database - view, create, edit, and upload records
                    </p>
                </div>


                {/* Data Type Selection */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    <Card
                        className="bg-white cursor-pointer hover:shadow-lg transition-shadow"
                        onClick={() => handleSelectDataType("medicines")}
                    >
                        <CardHeader>
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-emerald-100 rounded-lg">
                                    <Pill className="h-6 w-6 text-emerald-600" />
                                </div>
                                <div>
                                    <CardTitle>Medicines</CardTitle>
                                    <CardDescription>Manage medicine database</CardDescription>
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <p className="text-sm text-muted-foreground mb-3">
                                Add, edit, or upload medicines with salt composition
                            </p>
                            <Badge variant="secondary"><strong>{stats.medicines} records</strong></Badge>
                        </CardContent>
                    </Card>

                    <Card
                        className="bg-white cursor-pointer hover:shadow-lg transition-shadow"
                        onClick={() => handleSelectDataType("complaints")}
                    >
                        <CardHeader>
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-green-100 rounded-lg">
                                    <FileText className="h-6 w-6 text-green-600" />
                                </div>
                                <div>
                                    <CardTitle>Complaints</CardTitle>
                                    <CardDescription>Manage patient complaints</CardDescription>
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <p className="text-sm text-muted-foreground mb-3">
                                Add common patient symptoms and complaints for quick selection
                            </p>
                            <Badge variant="secondary"><strong>{stats.complaints} records</strong></Badge>
                        </CardContent>
                    </Card>

                    <Card
                        className="bg-white cursor-pointer hover:shadow-lg transition-shadow"
                        onClick={() => handleSelectDataType("diagnosis")}
                    >
                        <CardHeader>
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-purple-100 rounded-lg">
                                    <Stethoscope className="h-6 w-6 text-purple-600" />
                                </div>
                                <div>
                                    <CardTitle>Diagnosis</CardTitle>
                                    <CardDescription>Manage diagnosis database</CardDescription>
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <p className="text-sm text-muted-foreground mb-3">
                                Add diagnoses with ICD-10 codes for standardized medical records
                            </p>
                            <Badge variant="secondary"><strong>{stats.diagnosis} records</strong></Badge>
                        </CardContent>
                    </Card>

                    <Card
                        className="bg-white cursor-pointer hover:shadow-lg transition-shadow"
                        onClick={() => handleSelectDataType("medicalHistory")}
                    >
                        <CardHeader>
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-orange-100 rounded-lg">
                                    <ClipboardList className="h-6 w-6 text-orange-600" />
                                </div>
                                <div>
                                    <CardTitle>Medical History</CardTitle>
                                    <CardDescription>Manage medical history items</CardDescription>
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <p className="text-sm text-muted-foreground mb-3">
                                Add common medical history conditions for patient records
                            </p>
                            <Badge variant="secondary"><strong>{stats.medicalHistory} records</strong></Badge>
                        </CardContent>
                    </Card>

                    <Card
                        className="bg-white cursor-pointer hover:shadow-lg transition-shadow"
                        onClick={() => handleSelectDataType("tests")}
                    >
                        <CardHeader>
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-amber-100 rounded-lg">
                                    <Database className="h-6 w-6 text-amber-600" />
                                </div>
                                <div>
                                    <CardTitle>Tests</CardTitle>
                                    <CardDescription>Manage laboratory and diagnostic tests</CardDescription>
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <p className="text-sm text-muted-foreground mb-3">
                                Add laboratory tests and diagnostic procedures for patient prescriptions
                            </p>
                            <Badge variant="secondary"><strong>{stats.tests} records</strong></Badge>
                        </CardContent>
                    </Card>
                </div>
            </div>
        );
    }

    // Management View
    return (
        <div className="container mx-auto p-6 max-w-7xl">
            {/* Header */}
            <div className="mb-6 flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <Button variant="outline" onClick={handleBack}>
                        <ArrowLeft className="h-4 w-4 mr-2" />
                        Back
                    </Button>
                    <div className="flex items-center gap-3">
                        {selectedDataType && (() => {
                            const Icon = getDataTypeIcon(selectedDataType);
                            return <Icon className="h-6 w-6" />;
                        })()}
                        <div>
                            <h1 className="text-2xl font-bold">
                                {selectedDataType && getDataTypeLabel(selectedDataType)}
                            </h1>
                            <p className="text-sm text-muted-foreground">
                                {data?.length} of {stats[selectedDataType!]} records
                            </p>
                        </div>
                    </div>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" onClick={() => loadData()}>
                        <RefreshCw className="h-4 w-4 mr-2" />
                        Refresh
                    </Button>
                    <Button variant="outline" onClick={openUploadDialog}>
                        <Upload className="h-4 w-4 mr-2" />
                        Upload CSV
                    </Button>
                    <Button onClick={openCreateDialog}>
                        <Plus className="h-4 w-4 mr-2" />
                        Add New
                    </Button>
                </div>
            </div>

            {/* Search */}
            <div className="mb-6">
                <div className="relative">
                    <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10"
                    />
                </div>
            </div>

            {/* Data Table */}
            <Card className="bg-white">
                <CardContent className="p-0">
                    {isLoading ? (
                        <div className="flex items-center justify-center h-64">
                            <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
                        </div>
                    ) : data?.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                            <Database className="h-12 w-12 mb-4" />
                            <p>No records found</p>
                        </div>
                    ) : (
                        <>
                            <Table maxHeight="60vh">
                                <TableHeader>
                                    <TableRow>{renderTableHeaders()}</TableRow>
                                </TableHeader>
                                <TableBody>
                                    {sortedData?.map((item) => (
                                        <TableRow key={item.id}>{renderTableRow(item)}</TableRow>
                                    ))}
                                </TableBody>
                            </Table>

                            {/* Pagination */}
                            {totalPages > 1 && (
                                <div className="flex items-center justify-center gap-2 p-4 border-t">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={currentPage === 1}
                                        onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                                    >
                                        Previous
                                    </Button>
                                    <span className="text-sm text-muted-foreground">
                                        Page {currentPage} of {totalPages}
                                    </span>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={currentPage === totalPages}
                                        onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                                    >
                                        Next
                                    </Button>
                                </div>
                            )}
                        </>
                    )}
                </CardContent>
            </Card>

            {/* Delete Dialog */}
            <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This action cannot be undone. This will permanently delete the record from the database.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel className="border-2 border-gray-200 bg-white text-gray-700 hover:bg-gray-50">
                            Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction onClick={handleDelete} className="bg-[#DC2626] hover:bg-[#B91C1C] text-white">
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Edit Dialog */}
            <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
                <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0">
                    <div className="p-6 border-b flex-shrink-0">
                        <DialogHeader>
                            <DialogTitle>Edit Record</DialogTitle>
                            <DialogDescription>Make changes to the record below</DialogDescription>
                        </DialogHeader>
                    </div>
                    <div className="space-y-4 p-6 overflow-y-auto flex-1">{renderFormFields()}</div>
                    <div className="p-6 border-t flex-shrink-0">
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setShowEditDialog(false)} className="border-gray-200 bg-white text-gray-700 hover:bg-gray-50">
                                Cancel
                            </Button>
                            <Button onClick={handleEdit} className="bg-[#2563EB] hover:bg-[#1E40AF] text-white">Save Changes</Button>
                        </DialogFooter>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Create Dialog */}
            <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
                <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0">
                    <div className="p-6 border-b flex-shrink-0">
                        <DialogHeader>
                            <DialogTitle>Create New Record</DialogTitle>
                            <DialogDescription>Add a new record to the database</DialogDescription>
                        </DialogHeader>
                    </div>
                    <div className="space-y-4 p-6 overflow-y-auto flex-1">{renderFormFields()}</div>
                    <div className="p-6 border-t flex-shrink-0">
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setShowCreateDialog(false)} className="border-gray-200 bg-white text-gray-700 hover:bg-gray-50">
                                Cancel
                            </Button>
                            <Button onClick={handleCreate} className="bg-[#2563EB] hover:bg-[#1E40AF] text-white">Create</Button>
                        </DialogFooter>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Upload Dialog */}
            <Dialog open={showUploadDialog} onOpenChange={setShowUploadDialog}>
                <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col p-0">
                    <div className="p-6 border-b flex-shrink-0">
                        <DialogHeader>
                            <DialogTitle>Upload CSV File</DialogTitle>
                            <DialogDescription>
                                Upload a CSV file with headers matching the required database fields
                            </DialogDescription>
                        </DialogHeader>
                    </div>
                    <div className="space-y-4 py-4 px-6 overflow-y-auto flex-1">
                        {/* CSV Format Guide */}
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                            <h4 className="font-semibold text-blue-900 mb-2 flex items-center gap-2">
                                📋 Required CSV Format for {selectedDataType}
                            </h4>
                            <div className="text-sm space-y-2">
                                {selectedDataType === "medicines" && (
                                    <>
                                        <p className="text-blue-800">
                                            <strong>Required columns (first row):</strong>
                                        </p>
                                        <div className="bg-white p-2 rounded border border-blue-200 font-mono text-xs overflow-x-auto">
                                            <div className="text-green-600">name,salt</div>
                                        </div>
                                    </>
                                )}
                                {selectedDataType === "complaints" && (
                                    <>
                                        <p className="text-blue-800">
                                            <strong>Required columns (first row):</strong>
                                        </p>
                                        <div className="bg-white p-2 rounded border border-blue-200 font-mono text-xs overflow-x-auto">
                                            <div className="text-green-600">name</div>
                                        </div>
                                    </>
                                )}
                                {selectedDataType === "diagnosis" && (
                                    <>
                                        <p className="text-blue-800">
                                            <strong>Required columns (first row):</strong>
                                        </p>
                                        <div className="bg-white p-2 rounded border border-blue-200 font-mono text-xs overflow-x-auto">
                                            <div className="text-green-600">name,icdCode</div>
                                        </div>
                                    </>
                                )}
                                {selectedDataType === "medicalHistory" && (
                                    <>
                                        <p className="text-blue-800">
                                            <strong>Required columns (first row):</strong>
                                        </p>
                                        <div className="bg-white p-2 rounded border border-blue-200 font-mono text-xs overflow-x-auto">
                                            <div className="text-green-600">name</div>
                                        </div>
                                    </>
                                )}
                                {selectedDataType === "tests" && (
                                    <>
                                        <p className="text-blue-800">
                                            <strong>Required columns (first row):</strong>
                                        </p>
                                        <div className="bg-white p-2 rounded border border-blue-200 font-mono text-xs overflow-x-auto">
                                            <div className="text-green-600">name</div>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* File Upload Area */}
                        <div
                            className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-primary transition-colors"
                            onClick={() => document.getElementById("csv-upload")?.click()}
                        >
                            <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                            {uploadFile ? (
                                <div>
                                    <p className="font-medium">{uploadFile.name}</p>
                                    <p className="text-sm text-muted-foreground">
                                        {(uploadFile.size / 1024).toFixed(2)} KB
                                    </p>
                                </div>
                            ) : (
                                <div>
                                    <p className="font-medium mb-1">Click to upload or drag and drop</p>
                                    <p className="text-sm text-muted-foreground">CSV files only</p>
                                </div>
                            )}
                        </div>
                        <input
                            id="csv-upload"
                            type="file"
                            accept=".csv"
                            className="hidden"
                            onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                        />
                        {isUploading && (
                            <div className="space-y-2">
                                <div className="flex justify-between text-sm">
                                    <span>Uploading...</span>
                                    <span>{uploadProgress}%</span>
                                </div>
                                <div className="h-2 bg-secondary rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-primary transition-all duration-300"
                                        style={{ width: `${uploadProgress}%` }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                    <div className="p-6 border-t flex-shrink-0">
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setShowUploadDialog(false)} disabled={isUploading} className="border-gray-200 bg-white text-gray-700 hover:bg-gray-50">
                                Cancel
                            </Button>
                            <Button onClick={handleUpload} disabled={!uploadFile || isUploading} className="bg-[#2563EB] hover:bg-[#1E40AF] text-white">
                                Upload
                            </Button>
                        </DialogFooter>
                    </div>
                </DialogContent>
            </Dialog>
        </div >
    );
}
