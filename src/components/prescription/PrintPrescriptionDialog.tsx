export default function PrintPrescriptionDialog() {
    return (
        <div className="fixed inset-0 bg-black/20 flex items-center justify-center p-4 z-50">
            <div aria-labelledby="modal-title" aria-modal="true" className="bg-[var(--background-color)] rounded-xl shadow-2xl w-full max-w-md" role="dialog">
                <div className="p-8">
                    <div className="text-center">
                        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--primary-color-dark)]">
                            <span className="material-symbols-outlined text-[var(--primary-color)] text-3xl">print</span>
                        </div>
                        <h2 className="text-2xl font-bold mt-4" id="modal-title">Print or Save Prescription</h2>
                        <p className="text-gray-400 mt-2">
                            Choose your preferred method for handling the prescription. You can either print it directly or save it as a PDF file.
                        </p>
                    </div>
                    <div className="mt-8 space-y-6">
                        <div>
                            <h3 className="text-lg font-semibold flex items-center">
                                <span className="material-symbols-outlined mr-2 text-[var(--primary-color-light)]">print</span>
                                Print Options
                            </h3>
                            <div className="mt-4 space-y-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-300 mb-1" htmlFor="printer-select">Select Printer</label>
                                    <div className="relative">
                                        <select className="form-select w-full appearance-none rounded-md border-[var(--border-color)] bg-[var(--input-background)] pl-3 pr-10 py-3 text-white focus:border-[var(--primary-color)] focus:ring-[var(--primary-color)]" id="printer-select">
                                            <option>HP LaserJet Pro M404dn</option>
                                            <option>Canon PIXMA TR4520</option>
                                            <option>Epson EcoTank ET-2720</option>
                                        </select>
                                        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-[var(--primary-color-light)]">
                                            <span className="material-symbols-outlined">
                                                unfold_more
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <button className="w-full flex items-center justify-center gap-2 rounded-md border border-[var(--border-color)] bg-[var(--input-background)] px-4 py-3 text-sm font-medium text-white hover:bg-[var(--primary-color-dark)] focus:outline-none focus:ring-2 focus:ring-[var(--primary-color)] focus:ring-offset-2 focus:ring-offset-[var(--background-color)]" type="button">
                                            <span className="material-symbols-outlined">settings</span>
                                            <span>Advanced Print Settings</span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <div className="relative">
                                <div aria-hidden="true" className="absolute inset-0 flex items-center">
                                    <div className="w-full border-t border-[var(--border-color)]"></div>
                                </div>
                                <div className="relative flex justify-center">
                                    <span className="bg-[var(--background-color)] px-2 text-sm text-gray-400">OR</span>
                                </div>
                            </div>
                            <div>
                                <h3 className="text-lg font-semibold flex items-center">
                                    <span className="material-symbols-outlined mr-2 text-[var(--primary-color-light)]">save</span>
                                    Save as PDF
                                </h3>
                                <div className="mt-4">
                                    <button className="w-full flex items-center justify-center gap-2 rounded-md border border-[var(--border-color)] bg-[var(--input-background)] px-4 py-3 text-sm font-medium text-white hover:bg-[var(--primary-color-dark)] focus:outline-none focus:ring-2 focus:ring-[var(--primary-color)] focus:ring-offset-2 focus:ring-offset-[var(--background-color)]" type="button">
                                        <span className="material-symbols-outlined">folder_open</span>
                                        <span>Choose Save Location</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div className="mt-8 flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-4 space-y-4 sm:space-y-0 space-y-reverse">
                            <button className="w-full sm:w-auto justify-center rounded-md border border-transparent px-6 py-3 text-base font-medium text-white shadow-sm bg-[var(--primary-color-dark)] hover:bg-[var(--border-color)] focus:outline-none focus:ring-2 focus:ring-[var(--primary-color)] focus:ring-offset-2 focus:ring-offset-[var(--background-color)]" type="button">
                                Cancel
                            </button>
                            <button className="w-full sm:w-auto justify-center rounded-md border border-transparent bg-[var(--primary-color)] px-6 py-3 text-base font-bold text-[var(--background-color)] shadow-sm hover:bg-opacity-80 focus:outline-none focus:ring-2 focus:ring-[var(--primary-color)] focus:ring-offset-2 focus:ring-offset-[var(--background-color)]" type="button">
                                Confirm
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
