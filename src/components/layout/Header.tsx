'use client';

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

export default function Header() {
    const [isScrolled, setIsScrolled] = useState(false);
    const router = useRouter();

    useEffect(() => {
        const handleScroll = () => {
            setIsScrolled(window.scrollY > 10);
        };
        window.addEventListener('scroll', handleScroll);
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    const navItems = [
        { name: 'New Prescription', href: '/?status=reset' },
        { name: 'Patient Info', href: "/patient-infos" },
        { name: 'Manage Data', href: "/manage" },
    ];

    const handleTabClick = (href: string) => {
        router.push(href);
    };

    return (
        <motion.header
            className={`fixed top-0 right-0 left-0 z-50 transition-all duration-500 ${isScrolled
                ? 'border-gray-200 bg-white/95 border-b shadow-lg backdrop-blur-md'
                : 'bg-white border-b border-gray-100'
                }`}
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
        >
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                <div className="flex h-16 items-center justify-between">
                    <motion.div
                        className="flex flex-start items-center space-x-3"
                        whileHover={{ scale: 1.02 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                    >
                        <Link prefetch={false} href="/" className="flex items-center space-x-3">
                            <Image
                                src="/icon.png"
                                alt="Logo"
                                width={70}
                                height={40}
                                className="h-10 w-10 rounded-full shadow-sm"
                            />
                            <span className="font-semibold text-lg text-gray-900">Dr. Anil Kandya</span>
                        </Link>
                    </motion.div>

                    <nav className="hidden items-center space-x-2 lg:flex">
                        {navItems.map((item, index) => (
                            <motion.div
                                key={`nav-item-${index}`}
                                className="relative"
                                initial={{ opacity: 0, y: -10 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: index * 0.1 }}
                            >
                                <button
                                    className="relative rounded-lg px-4 py-2.5 text-sm font-medium transition-all duration-200 cursor-pointer
                                             text-gray-700 hover:text-[var(--primary-color)] hover:bg-[var(--secondary-color)]
                                             focus:outline-none focus:ring-2 focus:ring-[var(--primary-color)]/20 focus:bg-[var(--secondary-color)]"
                                    onClick={() => handleTabClick(item.href)}
                                >
                                    <span className="relative z-10">{item.name}</span>
                                </button>
                            </motion.div>
                        ))}
                    </nav>
                </div>
            </div>
        </motion.header>
    );
}